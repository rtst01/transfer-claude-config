'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cfg = require('./config');
const { log, ensureDir, walkStrings, readJsonSafe, timestamp } = require('./util');

const { homeVariants } = require('./util');

const UNIX_HINTS = /\.sh(\s|$|")|\/(usr|bin|etc)\/|(^|[\s|&;("'])(grep|sed|awk|jq|cat|chmod|ls)\s/;

const PLUGINS_DIR = 'plugins';
const INSTALLED_PLUGINS = 'installed_plugins.json';
const KNOWN_MARKETPLACES = 'known_marketplaces.json';

/**
 * Переводит пути в локальную домашнюю директорию с нормализацией разделителей.
 * Понимает портируемую форму "~/..." и абсолютные пути машины-источника.
 */
function makePathAdapter(srcHome, report) {
  // "~/" и "~\" — портируемая форма; абсолютные варианты — для старых бандлов
  const markers = ['~/', '~\\', ...homeVariants(srcHome)];
  const dstHome = cfg.HOME;
  const toNative = (s) => (cfg.IS_WIN ? s.replace(/\//g, '\\') : s.replace(/\\/g, '/'));
  const sep = cfg.IS_WIN ? '\\' : '/';

  return (str, keyPath) => {
    const hit = markers.find((m) => str.includes(m));
    if (!hit) return str;

    const replacement = hit.startsWith('~') ? dstHome + sep : dstHome;
    const startsWithHome = str.startsWith(hit);
    let out = str.split(hit).join(replacement);
    if (startsWithHome) {
      // строка целиком путь — нормализуем разделители под текущую ОС
      out = toNative(out);
    } else {
      report.reviewPaths.push(keyPath);
    }
    report.adaptedPaths.push(keyPath);
    return out;
  };
}

/** Адаптирует settings.json под текущую ОС. Возвращает новый текст. */
function adaptSettings(text, srcHome, report) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    report.warnings.push('settings.json не распарсился — применён без адаптации');
    return text;
  }

  obj = walkStrings(obj, makePathAdapter(srcHome, report));

  const winNoBash = cfg.IS_WIN && !cfg.hasBash();

  // statusLine: на Windows без bash шелл-скрипт не запустится — убираем, чтобы не ломать запуск
  if (winNoBash && obj.statusLine && /\.sh(\s|$|")|bash/.test(String(obj.statusLine.command || ''))) {
    delete obj.statusLine;
    report.skipped.push('settings.statusLine (bash-скрипт, на этой машине нет Git Bash)');
  }

  // hooks: не вырезаем, но честно предупреждаем о unix-командах
  if (winNoBash && obj.hooks && UNIX_HINTS.test(JSON.stringify(obj.hooks))) {
    report.warnings.push('В hooks есть unix-команды (grep/sed/.sh и т.п.) — без Git Bash они не заработают');
  }

  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Умный merge настроек: входящие — источник истины, но локальные дополнения
 * (permissions, env, enabledPlugins) не теряются при pull/import.
 */
function mergeSettings(incoming, local, report) {
  // порядок ключей — как во входящем (стабильный дифф против репо),
  // локальные ключи, которых нет во входящем, добавляются в конец
  const mergeObjects = (inc = {}, loc = {}) => {
    const out = { ...inc };
    for (const k of Object.keys(loc)) if (!(k in out)) out[k] = loc[k];
    return out;
  };
  const merged = mergeObjects(incoming, local);

  // env: локальные ключи, которых нет во входящем, сохраняются
  if (local.env || incoming.env) {
    merged.env = mergeObjects(incoming.env, local.env);
    const kept = Object.keys(local.env || {}).filter((k) => !(k in (incoming.env || {})));
    if (kept.length) report.merged.push(`env: сохранено локальных ключей — ${kept.length}`);
  }

  // enabledPlugins: объединение, входящее важнее
  if (local.enabledPlugins || incoming.enabledPlugins) {
    merged.enabledPlugins = mergeObjects(incoming.enabledPlugins, local.enabledPlugins);
  }

  // permissions.allow/deny/ask: объединение списков без дублей
  if (local.permissions || incoming.permissions) {
    merged.permissions = mergeObjects(incoming.permissions, local.permissions);
    for (const key of ['allow', 'deny', 'ask']) {
      const inc = (incoming.permissions || {})[key];
      const loc = (local.permissions || {})[key];
      if (!inc && !loc) continue;
      const extra = (loc || []).filter((p) => !(inc || []).includes(p));
      merged.permissions[key] = [...(inc || []), ...extra];
      if (extra.length) report.merged.push(`permissions.${key}: сохранено локальных правил — ${extra.length}`);
    }
  }

  return merged;
}

/** Бэкапит существующий файл в каталог бэкапа, сохраняя относительный путь. */
function backupFile(abs, rel, backupDir) {
  if (!fs.existsSync(abs)) return false;
  const dst = path.join(backupDir, rel);
  ensureDir(path.dirname(dst));
  fs.copyFileSync(abs, dst);
  return true;
}

/** Что из bundle.plugins ещё не установлено локально (плагины + их маркетплейсы). */
function computeMissingPlugins(bundlePlugins) {
  const dir = path.join(cfg.CLAUDE_DIR, PLUGINS_DIR);
  const installed = readJsonSafe(path.join(dir, INSTALLED_PLUGINS)) || {};
  const known = readJsonSafe(path.join(dir, KNOWN_MARKETPLACES)) || {};
  const localPlugins = installed.plugins || {};

  const plugins = (bundlePlugins.plugins || []).filter((key) => !(key in localPlugins));
  const marketplaces = Object.entries(bundlePlugins.marketplaces || {})
    .filter(([name]) => !(name in known))
    .map(([name, entry]) => ({ name, source: entry.source }));

  return { plugins, marketplaces };
}

/** Аргумент для `claude plugin marketplace add`: owner/repo для github, иначе url. */
function marketplaceAddArg(source) {
  if (!source) return null;
  if (source.source === 'github' && source.repo) return source.repo;
  if (source.url) return source.url;
  return null;
}

const claudeCmdLine = (args) => 'claude ' + args.join(' ');

/** Список команд claude для установки недостающего + ручные подсказки по нераспознанным источникам. */
function buildPluginCommands(missing) {
  const commands = [];
  const manual = [];
  for (const mp of missing.marketplaces) {
    const arg = marketplaceAddArg(mp.source);
    if (arg) commands.push(['plugin', 'marketplace', 'add', arg]);
    else manual.push(`маркетплейс «${mp.name}»: источник не распознан — добавь вручную (claude plugin marketplace add <repo|url>)`);
  }
  for (const key of missing.plugins) commands.push(['plugin', 'install', key]);
  return { commands, manual };
}

/** Ищет claude CLI в PATH (на Windows — с shell, чтобы находился .cmd). */
function findClaudeCli() {
  const candidates = cfg.IS_WIN ? ['claude.cmd', 'claude'] : ['claude'];
  for (const cmd of candidates) {
    try {
      if (spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: cfg.IS_WIN }).status === 0) return cmd;
    } catch {}
  }
  return null;
}

/**
 * Восстанавливает список плагинов через `claude plugin ...`.
 * Копируем только идентификаторы — сами плагины ставит claude CLI.
 * Ничего не пишет в консоль напрямую: только в report (иначе тихие хуки перестанут молчать).
 */
function applyPlugins(bundlePlugins, report, opts) {
  if (!bundlePlugins || !Array.isArray(bundlePlugins.plugins) || !bundlePlugins.plugins.length) return;

  const missing = computeMissingPlugins(bundlePlugins);
  if (!missing.plugins.length && !missing.marketplaces.length) return;

  const { commands, manual } = buildPluginCommands(missing);
  for (const m of manual) report.warnings.push(m);

  if (opts.dryRun) {
    if (missing.plugins.length) {
      report.written.push(`плагины к установке (${missing.plugins.length}): ${missing.plugins.join(', ')}`);
    }
    for (const c of commands) report.written.push('  ' + claudeCmdLine(c));
    return;
  }

  // Гард: тестовый/нестандартный HOME — claude CLI работал бы с реальным ~/.claude,
  // а не с этим. Ничего не выполняем, показываем команды для ручного запуска.
  if (process.env.CCSYNC_HOME && process.env.CCSYNC_HOME !== os.homedir()) {
    report.warnings.push('CCSYNC_HOME отличается от домашней директории — плагины не ставлю автоматически. Запусти вручную:');
    for (const c of commands) report.warnings.push('  ' + claudeCmdLine(c));
    return;
  }

  const claude = findClaudeCli();
  if (!claude) {
    report.warnings.push('claude CLI не найден в PATH — установи плагины вручную:');
    for (const c of commands) report.warnings.push('  ' + claudeCmdLine(c));
    return;
  }

  for (const c of commands) {
    // stdin закрыт и есть таймаут: если CLI задаст интерактивный вопрос — упадём, а не зависнем
    const r = spawnSync(claude, c, {
      encoding: 'utf8',
      shell: cfg.IS_WIN,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    if (r.status === 0) report.written.push(claudeCmdLine(c));
    else report.warnings.push(`не удалось: ${claudeCmdLine(c)} — запусти вручную`);
  }
}

/**
 * Применяет bundle к текущей машине.
 * opts: { dryRun }
 */
function apply(bundle, opts = {}) {
  const dryRun = !!opts.dryRun;
  const srcHome = bundle.meta.home;
  const report = {
    written: [],
    skipped: [],
    warnings: [],
    merged: [],
    adaptedPaths: [],
    reviewPaths: [],
    addedFiles: [],
    overwrittenFiles: [],
    backupDir: null,
  };

  const winNoBash = cfg.IS_WIN && !cfg.hasBash();
  if (bundle.meta.platform !== process.platform) {
    log.info(`Перенос ${bundle.meta.platform} → ${process.platform}: включена адаптация путей и совместимости`);
  }
  if (winNoBash) {
    log.warn('Git Bash не найден — bash-артефакты (statusline.sh) будут пропущены');
  }

  const backupDir = path.join(cfg.BACKUPS_DIR, 'ccsync-' + timestamp());

  const manifestByRel = new Map(cfg.MANIFEST.map((m) => [m.rel, m]));

  for (const [rel, entry] of Object.entries(bundle.files)) {
    const top = rel.split('/')[0];
    const item = manifestByRel.get(rel) || manifestByRel.get(top);
    if (!item) {
      report.skipped.push(`${rel} (не входит в манифест)`);
      continue;
    }
    if (item.unix && winNoBash) {
      report.skipped.push(`${rel} (unix-скрипт, нет bash)`);
      continue;
    }

    let content = Buffer.from(entry.b64, 'base64');
    const abs = path.join(cfg.CLAUDE_DIR, rel);
    if (item.adapt === 'settings') {
      let text = adaptSettings(content.toString('utf8'), srcHome, report);
      // merge с локальными настройками (если не --overwrite)
      if (!opts.overwrite && fs.existsSync(abs)) {
        try {
          const incoming = JSON.parse(text);
          const local = JSON.parse(fs.readFileSync(abs, 'utf8'));
          text = JSON.stringify(mergeSettings(incoming, local, report), null, 2) + '\n';
        } catch {
          report.warnings.push(`${rel}: merge не удался, применено как есть`);
        }
      }
      content = Buffer.from(text, 'utf8');
    }
    if (dryRun) {
      const exists = fs.existsSync(abs);
      report.written.push(`${rel} ${exists ? '(перезапись)' : '(новый)'}`);
      continue;
    }

    if (backupFile(abs, rel, backupDir)) {
      report.backupDir = backupDir;
      report.overwrittenFiles.push(rel);
    } else {
      report.addedFiles.push(rel); // файла не было — при откате его нужно удалить
    }
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, content);
    if (!cfg.IS_WIN) {
      try {
        fs.chmodSync(abs, rel.endsWith('.sh') ? 0o755 : entry.mode || 0o644);
      } catch {}
    }
    report.written.push(rel);
  }

  // mcpServers → аккуратный merge в ~/.claude.json (остальное содержимое не трогаем)
  if (bundle.mcpServers && Object.keys(bundle.mcpServers).length) {
    const adapted = walkStrings(bundle.mcpServers, makePathAdapter(srcHome, report));
    if (dryRun) {
      report.written.push(`mcpServers → ~/.claude.json: ${Object.keys(adapted).join(', ')}`);
    } else {
      const claudeJson = readJsonSafe(cfg.CLAUDE_JSON) || {};
      if (fs.existsSync(cfg.CLAUDE_JSON)) {
        backupFile(cfg.CLAUDE_JSON, '.claude.json', backupDir);
        report.backupDir = backupDir;
      }
      const before = claudeJson.mcpServers || {};
      const overwritten = Object.keys(adapted).filter(
        (k) => before[k] && JSON.stringify(before[k]) !== JSON.stringify(adapted[k])
      );
      claudeJson.mcpServers = { ...before, ...adapted };
      fs.writeFileSync(cfg.CLAUDE_JSON, JSON.stringify(claudeJson, null, 2) + '\n');
      report.written.push(`mcpServers (${Object.keys(adapted).length} шт.)`);
      if (overwritten.length) {
        report.warnings.push(`mcpServers перезаписаны: ${overwritten.join(', ')}`);
      }
    }
  }

  // плагины: восстанавливаем список через claude CLI (кэш/файлы не переносятся)
  applyPlugins(bundle.plugins, report, { dryRun });

  // манифест бэкапа: что перезаписано (восстановить) и что добавлено (удалить при откате)
  if (!dryRun && (report.addedFiles.length || report.overwrittenFiles.length)) {
    ensureDir(backupDir);
    fs.writeFileSync(
      path.join(backupDir, 'ccsync-manifest.json'),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          source: `${bundle.meta.hostname} (${bundle.meta.platform})`,
          added: report.addedFiles,
          overwritten: report.overwrittenFiles,
        },
        null,
        2
      ) + '\n'
    );
    report.backupDir = backupDir;
  }

  return report;
}

function printReport(report, dryRun) {
  log.title(dryRun ? 'План применения (dry-run):' : 'Применено:');
  for (const w of report.written) log.ok(w);
  if (report.skipped.length) {
    log.title('Пропущено:');
    for (const s of report.skipped) log.dim('  - ' + s);
  }
  for (const m of report.merged) log.ok('merge: ' + m);
  if (report.adaptedPaths.length) {
    log.info(`\nАдаптировано путей под эту ОС: ${report.adaptedPaths.length}`);
  }
  if (report.reviewPaths.length) {
    log.warn('Пути внутри команд заменены, проверь вручную: ' + report.reviewPaths.join(', '));
  }
  for (const w of report.warnings) log.warn(w);
  if (report.backupDir) log.dim(`\nБэкап прежних файлов: ${report.backupDir}`);
}

module.exports = { apply, printReport };
