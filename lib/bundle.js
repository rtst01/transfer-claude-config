'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const { collect, warnSecrets, BUNDLE_VERSION } = require('./collect');
const { log } = require('./util');

const MAGIC = 'CCSYNC1\n'; // сигнатура формата

/** Экспортирует конфигурацию в самодостаточный файл .ccsync (gzip-JSON). */
function exportBundle(outFile) {
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

  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'));
  fs.writeFileSync(outFile, Buffer.concat([Buffer.from(MAGIC), payload]));

  log.ok(`Экспортировано ${count} файлов → ${path.resolve(outFile)}`);
  if (bundle.mcpServers) log.ok(`mcpServers: ${Object.keys(bundle.mcpServers).length} шт.`);
  for (const m of missing) log.dim(`  (нет на этой машине: ${m})`);
  warnSecrets(bundle);
  return outFile;
}

/** Читает и валидирует файл .ccsync. */
function readBundle(file) {
  if (!fs.existsSync(file)) {
    log.err(`Файл не найден: ${file}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(file);
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
