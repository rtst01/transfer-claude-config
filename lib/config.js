'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// CCSYNC_HOME — переопределение домашней директории (для тестов и нестандартных схем)
const HOME = process.env.CCSYNC_HOME || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const CLAUDE_JSON = path.join(HOME, '.claude.json'); // здесь живут mcpServers
const STATE_FILE = path.join(CLAUDE_DIR, 'ccsync.json'); // конфиг самого ccsync (не синхронизируется)
const DEFAULT_REPO_DIR = path.join(HOME, '.claude-sync');
const BACKUPS_DIR = path.join(CLAUDE_DIR, 'backups');

const IS_WIN = process.platform === 'win32';

/**
 * Манифест синхронизации: что переносим из ~/.claude.
 *  type: file | dir
 *  unix: true — юниксовый артефакт, на Windows применяется только при наличии bash (Git Bash)
 */
const MANIFEST = [
  { key: 'settings', rel: 'settings.json', type: 'file', adapt: 'settings' },
  { key: 'memory', rel: 'CLAUDE.md', type: 'file' },
  { key: 'keybindings', rel: 'keybindings.json', type: 'file' },
  { key: 'statusline', rel: 'statusline.sh', type: 'file', unix: true },
  { key: 'agents', rel: 'agents', type: 'dir' },
  { key: 'skills', rel: 'skills', type: 'dir' },
  { key: 'commands', rel: 'commands', type: 'dir' },
];

// Явно НЕ синхронизируются: settings.local.json, projects/, sessions/,
// history.jsonl, cache/, telemetry/, plugins/ (переустанавливаются через /plugin),
// ccsync.json (локальный конфиг этого инструмента).

let _hasBash = null;
/** Есть ли bash в PATH (на Windows — Git Bash). */
function hasBash() {
  if (_hasBash === null) {
    try {
      const r = spawnSync(IS_WIN ? 'bash.exe' : 'bash', ['--version'], { stdio: 'ignore' });
      _hasBash = r.status === 0;
    } catch {
      _hasBash = false;
    }
  }
  return _hasBash;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

module.exports = {
  HOME,
  CLAUDE_DIR,
  CLAUDE_JSON,
  STATE_FILE,
  DEFAULT_REPO_DIR,
  BACKUPS_DIR,
  IS_WIN,
  MANIFEST,
  hasBash,
  readState,
  writeState,
};
