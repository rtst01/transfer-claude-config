'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const cfg = require('./config');
const { log } = require('./util');

const BIN = path.join(__dirname, '..', 'bin', 'ccsync.js');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Запускает CLI-команду, возвращает {code, output}. */
function runCli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...extraEnv } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, output: stripAnsi(out) }));
  });
}

// Команды, которые можно дёргать из веб-панели
const ALLOWED = {
  status: ['status'],
  diff: ['diff'],
  push: ['push'],
  pull: ['pull'],
  'pull-dry': ['pull', '--dry-run'],
  'autosync-on': ['autosync', 'on'],
  'autosync-off': ['autosync', 'off'],
  'autosync-status': ['autosync', 'status'],
};

function listDir(rel) {
  try {
    return fs
      .readdirSync(path.join(cfg.CLAUDE_DIR, rel))
      .filter((f) => !f.startsWith('.'))
      .map((f) => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}

function getState() {
  const state = cfg.readState();
  let repo = null;
  if (state.repoDir && fs.existsSync(path.join(state.repoDir, '.git'))) {
    const r = spawnSync('git', ['-C', state.repoDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
    const last = spawnSync('git', ['-C', state.repoDir, 'log', '-1', '--format=%cr · %s'], { encoding: 'utf8' });
    repo = {
      dir: state.repoDir,
      remote: r.status === 0 ? r.stdout.trim() : null,
      lastCommit: last.status === 0 ? last.stdout.trim() : null,
    };
  }
  let mcp = [];
  try {
    mcp = Object.keys(JSON.parse(fs.readFileSync(cfg.CLAUDE_JSON, 'utf8')).mcpServers || {});
  } catch {}
  const fileExists = (rel) => fs.existsSync(path.join(cfg.CLAUDE_DIR, rel));
  return {
    platform: process.platform,
    hostname: os.hostname().split('.')[0],
    home: cfg.HOME,
    autosync: !!state.autosync,
    repo,
    agents: listDir('agents'),
    skills: listDir('skills'),
    commands: listDir('commands'),
    mcp,
    files: {
      'settings.json': fileExists('settings.json'),
      'CLAUDE.md': fileExists('CLAUDE.md'),
      'keybindings.json': fileExists('keybindings.json'),
      'statusline.sh': fileExists('statusline.sh'),
    },
  };
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8'));
    } else if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, getState());
    } else if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const base = ALLOWED[body.cmd];
      if (!base) return json(res, 400, { error: 'unknown cmd' });
      const args = [...base];
      if (body.cmd === 'push' && body.message) args.push('-m', String(body.message));
      json(res, 200, await runCli(args));
    } else if (req.method === 'GET' && url.pathname === '/api/backups') {
      json(res, 200, require('./backups').listBackups().map(({ name, time, files }) => ({ name, time, files })));
    } else if (req.method === 'POST' && url.pathname === '/api/restore') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.name) return json(res, 400, { error: 'name required' });
      json(res, 200, await runCli(['restore', String(body.name)]));
    } else if (req.method === 'POST' && url.pathname === '/api/init') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      json(res, 200, await runCli(body.url ? ['init', String(body.url)] : ['init']));
    } else if (req.method === 'GET' && url.pathname === '/api/export') {
      const tmp = path.join(os.tmpdir(), `ccsync-export-${Date.now()}.ccsync`);
      const pass = req.headers['x-passphrase'];
      const args = pass ? ['export', tmp, '--encrypt'] : ['export', tmp];
      const r = await runCli(args, pass ? { CCSYNC_PASSPHRASE: String(pass) } : {});
      if (r.code !== 0 || !fs.existsSync(tmp)) return json(res, 500, r);
      const name = `claude-config-${os.hostname().split('.')[0]}-${new Date().toISOString().slice(0, 10)}.ccsync`;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      fs.createReadStream(tmp).pipe(res).on('finish', () => fs.unlink(tmp, () => {}));
    } else if (req.method === 'POST' && url.pathname === '/api/import') {
      const buf = await readBody(req);
      const tmp = path.join(os.tmpdir(), `ccsync-import-${Date.now()}.ccsync`);
      fs.writeFileSync(tmp, buf);
      const args = ['import', tmp];
      if (url.searchParams.get('dry') === '1') args.push('--dry-run');
      const pass = req.headers['x-passphrase'];
      const r = await runCli(args, pass ? { CCSYNC_PASSPHRASE: String(pass) } : {});
      fs.unlink(tmp, () => {});
      json(res, 200, r);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}

function openBrowser(urlStr) {
  const cmd =
    process.platform === 'darwin' ? ['open', urlStr] :
    process.platform === 'win32' ? ['cmd', '/c', 'start', '', urlStr] :
    ['xdg-open', urlStr];
  try {
    spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', detached: true }).unref();
  } catch {}
}

function startServer(port = 7842, attempt = 0) {
  const server = http.createServer(handler);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 10) startServer(port + 1, attempt + 1);
    else {
      log.err('Не удалось запустить сервер: ' + e.message);
      process.exit(1);
    }
  });
  // только localhost — панель не видна из сети
  server.listen(port, '127.0.0.1', () => {
    const urlStr = `http://127.0.0.1:${port}`;
    log.ok(`Веб-панель: ${urlStr}  (Ctrl+C — остановить)`);
    openBrowser(urlStr);
  });
}

module.exports = { startServer };
