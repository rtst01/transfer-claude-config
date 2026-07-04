'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cfg = require('./config');
const { log, readJsonSafe } = require('./util');

const BIN = path.join(__dirname, '..', 'bin', 'ccsync.js');
const LOG_FILE = path.join(cfg.CLAUDE_DIR, 'ccsync.log');
const SETTINGS = path.join(cfg.CLAUDE_DIR, 'settings.json');
const HOOK_TAG = 'ccsync auto'; // метка наших хуков в settings.json

const PULL_INTERVAL_MS = 30 * 60 * 1000; // pull не чаще раза в 30 минут
const PUSH_INTERVAL_MS = 5 * 60 * 1000;

// Хуки Claude Code: pull при старте сессии, push при завершении.
// Команда «ccsync» кроссплатформенна — нужен только глобально установленный ccsync.
const HOOKS = {
  SessionStart: { matcher: 'startup', hooks: [{ type: 'command', command: 'ccsync autopull', timeout: 60 }] },
  SessionEnd: { hooks: [{ type: 'command', command: 'ccsync autopush', timeout: 120 }] },
};

const isOurs = (entry) => JSON.stringify(entry).includes(HOOK_TAG);

function enable() {
  const s = readJsonSafe(SETTINGS) || {};
  s.hooks = s.hooks || {};
  for (const [event, entry] of Object.entries(HOOKS)) {
    const list = (s.hooks[event] = s.hooks[event] || []);
    if (!list.some(isOurs)) list.push(entry);
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
  cfg.writeState({ ...cfg.readState(), autosync: true });

  log.ok('Авто-синхронизация включена:');
  log.info('  • при старте сессии Claude Code — ccsync autopull (не чаще раза в 30 мин)');
  log.info('  • при завершении сессии — ccsync autopush (только если есть изменения)');
  log.dim(`  Журнал: ${LOG_FILE}`);
  if (!cfg.readState().repoDir) {
    log.warn('Git-репо ещё не настроен (ccsync init <url>) — хуки будут тихо бездействовать');
  }
  log.warn('Хуки уедут вместе с settings.json на другие машины — там тоже нужен установленный ccsync');
}

function disable() {
  const s = readJsonSafe(SETTINGS) || {};
  if (s.hooks) {
    for (const event of Object.keys(HOOKS)) {
      if (Array.isArray(s.hooks[event])) {
        s.hooks[event] = s.hooks[event].filter((e) => !isOurs(e));
        if (!s.hooks[event].length) delete s.hooks[event];
      }
    }
    if (!Object.keys(s.hooks).length) delete s.hooks;
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
  cfg.writeState({ ...cfg.readState(), autosync: false });
  log.ok('Авто-синхронизация выключена (хуки убраны из settings.json)');
}

function status() {
  const s = readJsonSafe(SETTINGS) || {};
  const active = Object.keys(HOOKS).filter((e) => (s.hooks?.[e] || []).some(isOurs));
  if (active.length) log.ok('Авто-синхронизация: включена (' + active.join(', ') + ')');
  else log.info('Авто-синхронизация: выключена. Включить: ccsync autosync on');
  if (fs.existsSync(LOG_FILE)) {
    const tail = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-12);
    log.title('Последние записи журнала:');
    for (const l of tail) log.dim('  ' + l);
  }
}

/** Тихо выполняет CLI-команду, пишет результат в журнал. Никогда не падает. */
function silentRun(args, label) {
  try {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 110000 });
    const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '').trim();
    const line = `[${new Date().toISOString()}] ${label} (exit ${r.status})\n${out.replace(/^/gm, '    ')}\n`;
    fs.appendFileSync(LOG_FILE, line);
    // журнал не разрастается бесконечно
    if (fs.statSync(LOG_FILE).size > 256 * 1024) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
      fs.writeFileSync(LOG_FILE, lines.slice(-800).join('\n'));
    }
  } catch {}
}

/** Хук SessionStart: подтянуть конфиг, с троттлингом. Всегда exit 0, ничего в stdout. */
function autopull() {
  const state = cfg.readState();
  if (!state.repoDir) return;
  if (state.lastAutoPull && Date.now() - state.lastAutoPull < PULL_INTERVAL_MS) return;
  cfg.writeState({ ...state, lastAutoPull: Date.now() });
  silentRun(['pull'], 'autopull');
}

/** Хук SessionEnd: отправить изменения. Всегда exit 0, ничего в stdout. */
function autopush() {
  const state = cfg.readState();
  if (!state.repoDir) return;
  if (state.lastAutoPush && Date.now() - state.lastAutoPush < PUSH_INTERVAL_MS) return;
  cfg.writeState({ ...state, lastAutoPush: Date.now() });
  silentRun(['push', '-m', `autosync from ${os.hostname().split('.')[0]} (${process.platform})`], 'autopush');
}

module.exports = { enable, disable, status, autopull, autopush };
