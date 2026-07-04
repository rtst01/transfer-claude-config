'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const cfg = require('./config');
const { log } = require('./util');

const VERSION = require('../package.json').version;
const REPO = 'rtst01/transfer-claude-config';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // раз в сутки

/** GET с follow-redirect (GitHub releases редиректят на CDN). */
function httpGet(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': `ccsync/${VERSION}`, Accept: 'application/octet-stream' } },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(httpGet(res.headers.location, dest, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} для ${url}`));
        }
        if (dest) {
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve(null)));
          out.on('error', reject);
        } else {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve(body));
        }
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('таймаут')));
  });
}

/** Возвращает "x.y.z" последнего релиза или null (сеть недоступна и т.п.). */
async function fetchLatestVersion() {
  try {
    const body = await httpGet(`https://api.github.com/repos/${REPO}/releases/latest`);
    const tag = JSON.parse(body).tag_name || '';
    return tag.replace(/^v/, '') || null;
  } catch {
    return null;
  }
}

const newer = (a, b) => {
  // a > b ?
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
};

/**
 * Тихая ежедневная проверка версии; печатает подсказку, если вышла новая.
 * Никогда не мешает основной команде.
 */
async function notifyIfOutdated() {
  try {
    const state = cfg.readState();
    if (state.lastUpdateCheck && Date.now() - state.lastUpdateCheck < CHECK_INTERVAL_MS) {
      if (state.latestKnown && newer(state.latestKnown, VERSION)) printHint(state.latestKnown);
      return;
    }
    cfg.writeState({ ...state, lastUpdateCheck: Date.now() });
    const latest = await fetchLatestVersion();
    if (!latest) return;
    cfg.writeState({ ...cfg.readState(), latestKnown: latest });
    if (newer(latest, VERSION)) printHint(latest);
  } catch {}
}

function printHint(latest) {
  log.dim(`\n  Доступна v${latest} (у тебя v${VERSION}) — обнови: ccsync update`);
}

/** ccsync update — обновляет сам себя (SEA-бинарь) или через npm. */
async function selfUpdate() {
  log.info(`Текущая версия: v${VERSION}`);
  const latest = await fetchLatestVersion();
  if (!latest) {
    log.err('Не удалось узнать последнюю версию (сеть/GitHub недоступны)');
    process.exit(1);
  }
  if (!newer(latest, VERSION)) {
    log.ok(`v${VERSION} — уже последняя`);
    return;
  }
  log.info(`Доступна v${latest} — обновляю…`);

  if (!cfg.IS_SEA) {
    // установка через npm — обновляем пакетом
    log.info('Установка через npm — запускаю npm install -g …');
    const r = spawnSync('npm', ['install', '-g', `git+https://github.com/${REPO}.git`], {
      stdio: 'inherit',
      shell: cfg.IS_WIN,
    });
    if (r.status === 0) log.ok(`Обновлено до v${latest}`);
    else log.err('npm install не удался — обнови вручную');
    return;
  }

  // SEA-бинарь: скачиваем архив под свою платформу и подменяем себя
  const plat = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
  const asset = cfg.IS_WIN ? `ccsync-${plat}-${process.arch}.zip` : `ccsync-${plat}-${process.arch}.tar.gz`;
  const url = `https://github.com/${REPO}/releases/latest/download/${asset}`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsync-update-'));
  const archive = path.join(tmp, asset);
  log.info(`Скачиваю ${asset}…`);
  await httpGet(url, archive);

  // tar есть и на Windows 10+ (bsdtar), он же распаковывает zip
  const ex = spawnSync('tar', ['-xf', archive, '-C', tmp], { encoding: 'utf8' });
  if (ex.status !== 0) {
    log.err('Распаковка не удалась: ' + (ex.stderr || ''));
    process.exit(1);
  }
  const newBin = path.join(tmp, cfg.IS_WIN ? 'ccsync.exe' : 'ccsync');
  if (!fs.existsSync(newBin)) {
    log.err('В архиве нет бинаря');
    process.exit(1);
  }

  const self = process.execPath;
  if (cfg.IS_WIN) {
    // запущенный exe нельзя перезаписать, но можно переименовать
    const old = self + '.old';
    try { fs.unlinkSync(old); } catch {}
    fs.renameSync(self, old);
    fs.copyFileSync(newBin, self);
  } else {
    fs.copyFileSync(newBin, self + '.new');
    fs.chmodSync(self + '.new', 0o755);
    fs.renameSync(self + '.new', self);
    if (process.platform === 'darwin') {
      spawnSync('xattr', ['-d', 'com.apple.quarantine', self], { stdio: 'ignore' });
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  cfg.writeState({ ...cfg.readState(), latestKnown: latest });
  log.ok(`Обновлено: v${VERSION} → v${latest} (${self})`);
}

module.exports = { VERSION, selfUpdate, notifyIfOutdated, fetchLatestVersion, newer };
