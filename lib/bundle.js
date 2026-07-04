'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const crypto = require('crypto');
const { collect, warnSecrets, BUNDLE_VERSION } = require('./collect');
const { log, promptPassword } = require('./util');

const MAGIC = 'CCSYNC1\n'; // обычный gzip-JSON
const MAGIC_ENC = 'CCSYNCE1\n'; // зашифрованный: salt(16) + iv(12) + tag(16) + AES-256-GCM(gzip-JSON)

function deriveKey(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 32);
}

function encrypt(payload, pass) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  const data = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([Buffer.from(MAGIC_ENC), salt, iv, cipher.getAuthTag(), data]);
}

function decrypt(raw, pass) {
  const off = MAGIC_ENC.length;
  const salt = raw.subarray(off, off + 16);
  const iv = raw.subarray(off + 16, off + 28);
  const tag = raw.subarray(off + 28, off + 44);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(raw.subarray(off + 44)), decipher.final()]);
}

/** Пароль: --password=… → CCSYNC_PASSPHRASE → интерактивный запрос. */
async function resolvePassword(opts, confirm) {
  if (opts.password) return opts.password;
  if (process.env.CCSYNC_PASSPHRASE) return process.env.CCSYNC_PASSPHRASE;
  if (!process.stdin.isTTY) {
    log.err('Архив зашифрован: задай пароль через --password=… или переменную CCSYNC_PASSPHRASE');
    process.exit(1);
  }
  const pass = await promptPassword('Пароль архива: ');
  if (!pass) {
    log.err('Пустой пароль');
    process.exit(1);
  }
  if (confirm) {
    const again = await promptPassword('Повтори пароль: ');
    if (again !== pass) {
      log.err('Пароли не совпадают');
      process.exit(1);
    }
  }
  return pass;
}

/** Экспортирует конфигурацию в файл .ccsync (gzip-JSON, опционально зашифрованный). */
async function exportBundle(outFile, opts = {}) {
  const { bundle, missing } = collect();

  const count = Object.keys(bundle.files).length;
  if (!count) {
    log.err('Нечего экспортировать: в ~/.claude не найдено ни одного файла из манифеста');
    process.exit(1);
  }

  if (!outFile) {
    const d = new Date().toISOString().slice(0, 10);
    outFile = `claude-config-${os.hostname().split('.')[0]}-${d}.ccsync`;
  }
  if (!outFile.endsWith('.ccsync')) outFile += '.ccsync';

  let payload = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'));
  let enc = false;
  if (opts.encrypt) {
    payload = encrypt(payload, await resolvePassword(opts, true));
    enc = true;
    fs.writeFileSync(outFile, payload);
  } else {
    fs.writeFileSync(outFile, Buffer.concat([Buffer.from(MAGIC), payload]));
  }

  log.ok(`Экспортировано ${count} файлов → ${path.resolve(outFile)}${enc ? '  🔒 AES-256' : ''}`);
  if (bundle.mcpServers) log.ok(`mcpServers: ${Object.keys(bundle.mcpServers).length} шт.`);
  for (const m of missing) log.dim(`  (нет на этой машине: ${m})`);
  if (!enc) warnSecrets(bundle);
  return outFile;
}

/** Читает и валидирует файл .ccsync (при необходимости расшифровывает). */
async function readBundle(file, opts = {}) {
  if (!fs.existsSync(file)) {
    log.err(`Файл не найден: ${file}`);
    process.exit(1);
  }
  let raw = fs.readFileSync(file);

  if (raw.subarray(0, MAGIC_ENC.length).equals(Buffer.from(MAGIC_ENC))) {
    const pass = await resolvePassword(opts, false);
    try {
      raw = Buffer.concat([Buffer.from(MAGIC), decrypt(raw, pass)]);
    } catch {
      log.err('Не удалось расшифровать: неверный пароль или архив повреждён');
      process.exit(1);
    }
  }

  if (!raw.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC))) {
    log.err('Это не файл ccsync (нет сигнатуры CCSYNC1)');
    process.exit(1);
  }
  let bundle;
  try {
    bundle = JSON.parse(zlib.gunzipSync(raw.subarray(MAGIC.length)).toString('utf8'));
  } catch (e) {
    log.err('Файл повреждён: ' + e.message);
    process.exit(1);
  }
  if (bundle.meta.version > BUNDLE_VERSION) {
    log.warn(`Бандл создан более новой версией ccsync (v${bundle.meta.version}) — возможны несовместимости`);
  }
  return bundle;
}

module.exports = { exportBundle, readBundle };
