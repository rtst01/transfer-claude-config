'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const cfg = require('./config');
const { log, readJsonSafe } = require('./util');
const { VERSION } = require('./update');

function has(cmd, args = ['--version']) {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore', shell: false }).status === 0;
  } catch {
    return false;
  }
}

/** ccsync doctor — диагностика окружения с рецептами. */
async function doctor() {
  const rows = [];
  const ok = (name, detail = '') => rows.push(['ok', name, detail]);
  const warn = (name, fix) => rows.push(['warn', name, fix]);
  const bad = (name, fix) => rows.push(['bad', name, fix]);

  log.title(`ccsync doctor  (v${VERSION}, ${process.platform}/${process.arch}${cfg.IS_SEA ? ', standalone' : ', node'})`);

  // базовое окружение
  fs.existsSync(cfg.CLAUDE_DIR)
    ? ok('~/.claude существует')
    : bad('~/.claude не найден', 'запусти Claude Code хотя бы раз');

  has('git') ? ok('git установлен') : bad('git не найден', 'установи git — без него не работает режим синхронизации через репозиторий');

  if (cfg.IS_WIN) {
    cfg.hasBash()
      ? ok('Git Bash найден (statusline и unix-хуки будут работать)')
      : warn('Git Bash не найден', 'установи Git for Windows — иначе bash-артефакты будут пропускаться');
  }

  // ccsync в PATH — критично для хуков авто-синка
  const which = spawnSync(cfg.IS_WIN ? 'where' : 'which', ['ccsync'], { encoding: 'utf8' });
  which.status === 0
    ? ok('ccsync в PATH', which.stdout.trim().split('\n')[0])
    : warn('ccsync не в PATH', 'хуки авто-синка вызывают «ccsync» — положи бинарь в PATH');

  // карантин macOS
  if (process.platform === 'darwin' && cfg.IS_SEA) {
    const xattr = spawnSync('xattr', [process.execPath], { encoding: 'utf8' });
    (xattr.stdout || '').includes('com.apple.quarantine')
      ? warn('бинарь под карантином Gatekeeper', `xattr -d com.apple.quarantine "${process.execPath}"`)
      : ok('карантин Gatekeeper снят');
  }

  // git-синхронизация
  const state = cfg.readState();
  if (state.repoDir && fs.existsSync(path.join(state.repoDir, '.git'))) {
    ok('синк-репо настроен', state.repoDir);
    const remote = spawnSync('git', ['-C', state.repoDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
    if (remote.status === 0) {
      const url = remote.stdout.trim();
      const reach = spawnSync('git', ['-C', state.repoDir, 'ls-remote', '--exit-code', 'origin', 'HEAD'], {
        encoding: 'utf8',
        timeout: 15000,
      });
      reach.status === 0
        ? ok('remote доступен', url)
        : bad('remote недоступен', `проверь доступ/ключи: git -C "${state.repoDir}" fetch (${url})`);
    } else {
      warn('remote не настроен', `git -C "${state.repoDir}" remote add origin <url приватного репо>`);
    }
  } else {
    warn('git-синхронизация не настроена', 'ccsync init <url приватного репо>');
  }

  // хуки авто-синка
  const settings = readJsonSafe(path.join(cfg.CLAUDE_DIR, 'settings.json')) || {};
  const hooksStr = JSON.stringify(settings.hooks || {});
  if (hooksStr.includes('ccsync auto')) {
    which.status === 0
      ? ok('авто-синхронизация включена (хуки на месте)')
      : bad('хуки авто-синка есть, но ccsync не в PATH', 'хуки молча не работают — добавь ccsync в PATH');
  } else {
    ok('авто-синхронизация выключена', 'включить: ccsync autosync on');
  }

  // сеть до GitHub (для update)
  const { fetchLatestVersion, newer } = require('./update');
  const latest = await fetchLatestVersion();
  if (!latest) warn('GitHub API недоступен', 'ccsync update и проверка версий не сработают (сеть/прокси?)');
  else if (newer(latest, VERSION)) warn(`доступна v${latest}`, 'обнови: ccsync update');
  else ok(`версия актуальна (v${VERSION})`);

  // вывод
  console.log();
  let bads = 0;
  for (const [kind, name, detail] of rows) {
    if (kind === 'ok') log.ok(name + (detail ? '  — ' + detail : ''));
    else if (kind === 'warn') log.warn(name + (detail ? '  → ' + detail : ''));
    else {
      bads++;
      log.err(name + (detail ? '  → ' + detail : ''));
    }
  }
  console.log();
  if (bads) log.err(`Проблем: ${bads}`);
  else log.ok('Всё в порядке');
}

module.exports = { doctor };
