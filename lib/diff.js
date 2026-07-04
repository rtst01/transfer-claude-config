'use strict';

const { collect } = require('./collect');
const { log } = require('./util');

/** Рекурсивный дифф JSON-объектов: пути изменённых/добавленных/удалённых ключей. */
function jsonDiff(a, b, prefix, out, limit = 40) {
  if (out.length >= limit) return;
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = prefix ? prefix + '.' + k : k;
      if (!(k in b)) out.push(`  − ${p}`);
      else if (!(k in a)) out.push(`  + ${p} = ${short(b[k])}`);
      else jsonDiff(a[k], b[k], p, out, limit);
      if (out.length >= limit) return;
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push(`  ~ ${prefix}: ${short(a)} → ${short(b)}`);
  }
}

function short(v) {
  const s = JSON.stringify(v);
  return s && s.length > 60 ? s.slice(0, 57) + '…' : s;
}

const text = (entry) => Buffer.from(entry.b64, 'base64').toString('utf8');

/** Дифф бандла (архива) против локальной конфигурации: что изменит import. */
function diffBundle(bundle) {
  const { bundle: local } = collect();
  const rels = [...new Set([...Object.keys(bundle.files), ...Object.keys(local.files)])].sort();
  let same = 0;

  log.title(`Архив от ${bundle.meta.hostname} (${bundle.meta.platform}) против этой машины:`);
  for (const rel of rels) {
    const inc = bundle.files[rel];
    const loc = local.files[rel];
    if (inc && !loc) {
      log.info(`  + ${rel}  (будет добавлен)`);
    } else if (!inc && loc) {
      log.dim(`  − ${rel}  (только локально — импорт его не тронет)`);
    } else if (inc.b64 !== loc.b64) {
      log.info(`  ~ ${rel}  (отличается)`);
      if (rel === 'settings.json') {
        try {
          const out = [];
          jsonDiff(JSON.parse(text(loc)), JSON.parse(text(inc)), '', out);
          for (const l of out) log.dim('  ' + l);
        } catch {}
      }
    } else {
      same++;
    }
  }

  // mcpServers
  const out = [];
  jsonDiff(local.mcpServers || {}, bundle.mcpServers || {}, 'mcpServers', out);
  for (const l of out) log.info(l);

  log.dim(`\n  Без изменений: ${same} файл(ов)`);
}

module.exports = { diffBundle, jsonDiff };
