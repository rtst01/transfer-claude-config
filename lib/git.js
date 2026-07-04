'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cfg = require('./config');
const { collect, warnSecrets } = require('./collect');
const { log, ensureDir, walkDir, readJsonSafe } = require('./util');

function git(repoDir, args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
  });
  if (r.error && r.error.code === 'ENOENT') {
    log.err('git не найден в PATH — установи git и повтори');
    process.exit(1);
  }
  return r;
}

function requireRepo() {
  const state = cfg.readState();
  const repoDir = state.repoDir;
  if (!repoDir || !fs.existsSync(path.join(repoDir, '.git'))) {
    log.err('Git-синхронизация не настроена. Сначала: ccsync init <url-репозитория>');
    process.exit(1);
  }
  return repoDir;
}

/** ccsync init [url] — клонирует/создаёт локальный репозиторий синхронизации. */
function init(url, opts = {}) {
  const repoDir = opts.dir || cfg.DEFAULT_REPO_DIR;

  if (fs.existsSync(path.join(repoDir, '.git'))) {
    log.ok(`Репозиторий уже существует: ${repoDir}`);
  } else if (url) {
    log.info(`Клонирую ${url} → ${repoDir}`);
    const r = git(process.cwd(), ['clone', url, repoDir], { inherit: true });
    if (r.status !== 0) {
      log.err('Клонирование не удалось');
      process.exit(1);
    }
  } else {
    ensureDir(repoDir);
    git(repoDir, ['init', '-b', 'main']);
    log.ok(`Создан локальный репозиторий: ${repoDir}`);
    log.dim('  Добавь remote: git -C ' + repoDir + ' remote add origin <url>');
  }

  // .gitattributes: шелл-скрипты всегда с LF, иначе сломаются на Mac после Windows
  const ga = path.join(repoDir, '.gitattributes');
  if (!fs.existsSync(ga)) {
    fs.writeFileSync(ga, '* text=auto\n*.sh text eol=lf\n*.md text\n');
  }

  cfg.writeState({ ...cfg.readState(), repoDir, remote: url || null });
  log.ok('Настроено. Теперь: ccsync push — выгрузить, ccsync pull — забрать и применить');
}

/** Раскладывает текущую конфигурацию в рабочую копию репозитория. */
function materialize(repoDir) {
  const { bundle, missing } = collect();

  const claudeRoot = path.join(repoDir, 'claude');
  // подчищаем прежнее состояние, чтобы удалённые файлы удалялись и в репо
  fs.rmSync(claudeRoot, { recursive: true, force: true });

  for (const [rel, entry] of Object.entries(bundle.files)) {
    const abs = path.join(claudeRoot, rel);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, Buffer.from(entry.b64, 'base64'));
  }
  fs.writeFileSync(
    path.join(repoDir, 'meta.json'),
    JSON.stringify(bundle.meta, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(repoDir, 'mcp-servers.json'),
    JSON.stringify(bundle.mcpServers || {}, null, 2) + '\n'
  );
  return { bundle, missing };
}

/** Собирает bundle из рабочей копии репозитория. */
function bundleFromRepo(repoDir) {
  const meta = readJsonSafe(path.join(repoDir, 'meta.json'));
  if (!meta) {
    log.err('В репозитории нет meta.json — сначала сделай ccsync push с другой машины');
    process.exit(1);
  }
  const files = {};
  const claudeRoot = path.join(repoDir, 'claude');
  for (const rel of walkDir(claudeRoot)) {
    files[rel] = { b64: fs.readFileSync(path.join(claudeRoot, rel)).toString('base64'), mode: 0o644 };
  }
  const mcpServers = readJsonSafe(path.join(repoDir, 'mcp-servers.json'));
  return { meta, files, mcpServers: mcpServers && Object.keys(mcpServers).length ? mcpServers : null };
}

function hasRemote(repoDir) {
  return git(repoDir, ['remote']).stdout.trim().length > 0;
}

/** ccsync push — конфиг → репо → commit → push. */
function push(message) {
  const repoDir = requireRepo();

  // сначала подтягиваем чужие изменения, чтобы не плодить конфликты
  if (hasRemote(repoDir)) {
    const pr = git(repoDir, ['pull', '--rebase', '--autostash']);
    if (pr.status !== 0 && !/couldn't find remote ref|no tracking information|no such ref was fetched/i.test(pr.stderr)) {
      log.warn('git pull перед push не удался:\n' + pr.stderr.trim());
    }
  }

  const { bundle } = materialize(repoDir);
  warnSecrets(bundle);

  git(repoDir, ['add', '-A']);
  const diff = git(repoDir, ['status', '--porcelain']);
  // meta.json меняется при каждом сборе (timestamp) — сам по себе не повод для коммита
  const realChanges = diff.stdout.split('\n').filter((l) => l.trim() && !l.includes('meta.json'));
  if (!realChanges.length) {
    git(repoDir, ['reset', '-q']);
    git(repoDir, ['checkout', '--', '.']);
    log.ok('Изменений нет — репозиторий актуален');
    return;
  }

  const msg = message || `sync from ${os.hostname().split('.')[0]} (${process.platform})`;
  const cr = git(repoDir, ['commit', '-m', msg]);
  if (cr.status !== 0) {
    log.err('Коммит не удался:\n' + (cr.stderr || cr.stdout));
    process.exit(1);
  }
  log.ok(`Коммит: ${msg}`);

  if (hasRemote(repoDir)) {
    const branch = git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    const r = git(repoDir, ['push', '-u', 'origin', branch], { inherit: true });
    if (r.status === 0) log.ok('Отправлено на remote');
    else log.err('push не удался — проверь доступ к репозиторию');
  } else {
    log.warn('Remote не настроен — коммит только локальный. Добавь: git -C ' + repoDir + ' remote add origin <url>');
  }
}

/** ccsync pull — забрать из репо и применить. Возвращает bundle или null. */
function pull(opts = {}) {
  const repoDir = requireRepo();

  if (hasRemote(repoDir)) {
    log.info('Забираю изменения…');
    const r = git(repoDir, ['pull', '--rebase', '--autostash'], { inherit: true });
    if (r.status !== 0) {
      log.err('git pull не удался — разбери конфликт в ' + repoDir);
      process.exit(1);
    }
  } else {
    log.warn('Remote не настроен — применяю то, что лежит в ' + repoDir);
  }

  return bundleFromRepo(repoDir);
}

/** ccsync status — что изменилось локально относительно репозитория. */
function status() {
  const state = cfg.readState();
  if (!state.repoDir || !fs.existsSync(path.join(state.repoDir, '.git'))) {
    log.info('Git-синхронизация не настроена (ccsync init <url>).');
    const { bundle, missing } = collect();
    log.title('Будет экспортировано:');
    for (const rel of Object.keys(bundle.files)) log.dim('  ' + rel);
    if (bundle.mcpServers) log.dim('  mcpServers: ' + Object.keys(bundle.mcpServers).join(', '));
    for (const m of missing) log.dim('  (отсутствует: ' + m + ')');
    return;
  }

  const repoDir = state.repoDir;
  materialize(repoDir);
  const diff = git(repoDir, ['status', '--porcelain']);
  const lines = diff.stdout.split('\n').filter((l) => l.trim() && !l.includes('meta.json'));
  if (!lines.length) {
    log.ok('Локальная конфигурация совпадает с репозиторием');
    git(repoDir, ['checkout', '--', '.']);
  } else {
    log.title('Отличия от репозитория:');
    console.log(lines.join('\n'));
    log.dim('\nccsync push — отправить, ccsync pull — перезаписать локальное из репо');
  }
}

module.exports = { init, push, pull, status };
