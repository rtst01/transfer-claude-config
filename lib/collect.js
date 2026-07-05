'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');
const { walkDir, readJsonSafe, log, normalizeHome, walkStrings } = require('./util');

const BUNDLE_VERSION = 1;

const PLUGINS_DIR = 'plugins';
const INSTALLED_PLUGINS = 'installed_plugins.json';
const KNOWN_MARKETPLACES = 'known_marketplaces.json';

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[bpars]-[A-Za-z0-9-]{10,}/,
];

/** Ищет похожие на секреты значения в тексте; возвращает список замаскированных находок. */
function findSecrets(text) {
  const found = [];
  for (const re of SECRET_PATTERNS) {
    const m = text.match(new RegExp(re, 'g'));
    if (m) for (const s of m) found.push(s.slice(0, 8) + '…' + s.slice(-4));
  }
  return found;
}

/**
 * Собирает портируемый список плагинов из ~/.claude/plugins.
 * Переносим только идентификаторы (имя@маркетплейс + источник маркетплейса),
 * чтобы восстановить их через `claude plugin ...` — кэш и локальные пути НЕ включаем.
 * Возвращает { marketplaces, plugins } или null, если установленных плагинов нет.
 */
function collectPlugins() {
  const pluginsDir = path.join(cfg.CLAUDE_DIR, PLUGINS_DIR);
  const installed = readJsonSafe(path.join(pluginsDir, INSTALLED_PLUGINS));

  const plugins = installed && installed.plugins ? Object.keys(installed.plugins).sort() : [];
  if (!plugins.length) return null;

  const known = readJsonSafe(path.join(pluginsDir, KNOWN_MARKETPLACES)) || {};
  const marketplaces = {};
  for (const [name, entry] of Object.entries(known)) {
    if (entry && entry.source) marketplaces[name] = { source: entry.source };
  }

  return { marketplaces, plugins };
}

/**
 * Собирает текущую конфигурацию в bundle:
 * { meta, files: { 'relpath': { b64, mode } }, mcpServers, plugins }
 */
function collect() {
  const files = {};
  const missing = [];

  for (const item of cfg.MANIFEST) {
    const abs = path.join(cfg.CLAUDE_DIR, item.rel);
    if (!fs.existsSync(abs)) {
      missing.push(item.rel);
      continue;
    }
    if (item.type === 'file') {
      const entry = readFileEntry(abs);
      if (item.adapt === 'settings') {
        // пути храним в портируемой форме "~/..." — одинаково для всех машин.
        // Нормализуем распарсенные строки: в сыром JSON-тексте \ экранированы,
        // и Windows-пути иначе не находятся.
        try {
          const obj = JSON.parse(Buffer.from(entry.b64, 'base64').toString('utf8'));
          const norm = walkStrings(obj, (s) => normalizeHome(s, cfg.HOME));
          entry.b64 = Buffer.from(JSON.stringify(norm, null, 2) + '\n', 'utf8').toString('base64');
        } catch {
          // не JSON — оставляем как есть
        }
      }
      files[item.rel] = entry;
    } else {
      for (const rel of walkDir(abs)) {
        files[item.rel + '/' + rel] = readFileEntry(path.join(abs, rel));
      }
    }
  }

  // mcpServers — только этот блок из ~/.claude.json, без истории и прочего
  const claudeJson = readJsonSafe(cfg.CLAUDE_JSON);
  const mcpServers =
    claudeJson && claudeJson.mcpServers
      ? walkStrings(claudeJson.mcpServers, (s) => normalizeHome(s, cfg.HOME))
      : null;

  const bundle = {
    meta: {
      version: BUNDLE_VERSION,
      createdAt: new Date().toISOString(),
      platform: process.platform,
      hostname: os.hostname(),
      home: cfg.HOME,
    },
    files,
    mcpServers,
    plugins: collectPlugins(),
  };

  return { bundle, missing };
}

function readFileEntry(abs) {
  const buf = fs.readFileSync(abs);
  let mode = 0o644;
  try {
    mode = fs.statSync(abs).mode & 0o777;
  } catch {}
  return { b64: buf.toString('base64'), mode };
}

/** Предупреждает о возможных секретах в собранных файлах. */
function warnSecrets(bundle) {
  const hits = [];
  for (const [rel, entry] of Object.entries(bundle.files)) {
    const text = Buffer.from(entry.b64, 'base64').toString('utf8');
    for (const s of findSecrets(text)) hits.push(`${rel}: ${s}`);
  }
  if (bundle.mcpServers) {
    for (const s of findSecrets(JSON.stringify(bundle.mcpServers))) hits.push(`mcpServers: ${s}`);
  }
  if (hits.length) {
    log.warn('Найдены строки, похожие на секреты/токены:');
    for (const h of hits) log.dim('    ' + h);
    log.warn('Убедись, что архив/репозиторий приватный, или вынеси ключи в settings.local.json');
  }
  return hits;
}

module.exports = { collect, collectPlugins, warnSecrets, BUNDLE_VERSION };
