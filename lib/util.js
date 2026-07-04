'use strict';

const fs = require('fs');
const path = require('path');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

const log = {
  info: (s) => console.log(s),
  ok: (s) => console.log(c('32', '✓ ') + s),
  warn: (s) => console.log(c('33', '⚠ ') + s),
  err: (s) => console.error(c('31', '✗ ') + s),
  dim: (s) => console.log(c('2', s)),
  title: (s) => console.log('\n' + c('1', s)),
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Рекурсивный обход каталога, возвращает относительные пути файлов. */
function walkDir(dir, excludes = ['.DS_Store', 'Thumbs.db']) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (cur, rel) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      if (excludes.includes(entry.name)) continue;
      const abs = path.join(cur, entry.name);
      const r = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(abs, r);
      else if (entry.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

/** Обходит все строковые значения объекта, заменяя их результатом fn. */
function walkStrings(obj, fn, keyPath = '') {
  if (typeof obj === 'string') return fn(obj, keyPath);
  if (Array.isArray(obj)) return obj.map((v, i) => walkStrings(v, fn, `${keyPath}[${i}]`));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = walkStrings(v, fn, keyPath ? `${keyPath}.${k}` : k);
    }
    return out;
  }
  return obj;
}

/** Запрашивает пароль без эха в терминале. */
function promptPassword(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      // не терминал — читаем строку как есть (для пайпов/скриптов)
      const rl = require('readline').createInterface({ input: stdin });
      rl.once('line', (l) => { rl.close(); resolve(l); });
      return;
    }
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    let pass = '';
    const onData = (buf) => {
      const ch = buf.toString('utf8');
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        stdout.write('\n');
        resolve(pass);
      } else if (ch === '\u0003') { // Ctrl+C
        stdout.write('\n');
        process.exit(1);
      } else if (ch === '\u007f' || ch === '\b') { // Backspace
        pass = pass.slice(0, -1);
      } else {
        pass += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** Варианты записи домашней директории (прямые/обратные слэши), от длинных к коротким. */
function homeVariants(home) {
  const fwd = home.replace(/\\/g, '/');
  const back = home.replace(/\//g, '\\');
  return [...new Set([home, fwd, back])].sort((a, b) => b.length - a.length);
}

/** Заменяет вхождения домашней директории на "~" — портируемая форма для хранения. */
function normalizeHome(text, home) {
  let out = text;
  for (const v of homeVariants(home)) out = out.split(v).join('~');
  return out;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

module.exports = { log, ensureDir, readJsonSafe, walkDir, walkStrings, timestamp, homeVariants, normalizeHome, promptPassword };
