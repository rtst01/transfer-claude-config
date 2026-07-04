'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { log, ensureDir, walkStrings, readJsonSafe, timestamp } = require('./util');

const { homeVariants } = require('./util');

const UNIX_HINTS = /\.sh(\s|$|")|\/(usr|bin|etc)\/|(^|[\s|&;("'])(grep|sed|awk|jq|cat|chmod|ls)\s/;

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
  const merged = { ...local, ...incoming };

  // env: локальные ключи, которых нет во входящем, сохраняются
  if (local.env || incoming.env) {
    merged.env = { ...local.env, ...incoming.env };
    const kept = Object.keys(local.env || {}).filter((k) => !(k in (incoming.env || {})));
    if (kept.length) report.merged.push(`env: сохранено локальных ключей — ${kept.length}`);
  }

  // enabledPlugins: объединение, входящее важнее
  if (local.enabledPlugins || incoming.enabledPlugins) {
    merged.enabledPlugins = { ...local.enabledPlugins, ...incoming.enabledPlugins };
  }

  // permissions.allow/deny/ask: объединение списков без дублей
  if (local.permissions || incoming.permissions) {
    merged.permissions = { ...(local.permissions || {}), ...(incoming.permissions || {}) };
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

    if (backupFile(abs, rel, backupDir)) report.backupDir = backupDir;
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
