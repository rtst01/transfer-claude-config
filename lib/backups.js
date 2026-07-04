'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { log, ensureDir, walkDir, readJsonSafe } = require('./util');

const MANIFEST_NAME = 'ccsync-manifest.json';

/** Список бэкапов ccsync, новые первыми. */
function listBackups() {
  if (!fs.existsSync(cfg.BACKUPS_DIR)) return [];
  return fs
    .readdirSync(cfg.BACKUPS_DIR)
    .filter((n) => n.startsWith('ccsync-') && !n.endsWith('.json'))
    .sort()
    .reverse()
    .map((name) => {
      const dir = path.join(cfg.BACKUPS_DIR, name);
      const files = walkDir(dir).filter((f) => f !== MANIFEST_NAME);
      const manifest = readJsonSafe(path.join(dir, MANIFEST_NAME));
      // ccsync-YYYYMMDD-HHMMSS → "YYYY-MM-DD HH:MM:SS"
      const m = name.match(/^ccsync-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
      const time = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : name;
      return { name, dir, time, files, manifest };
    })
    .filter((b) => b.files.length > 0 || (b.manifest && b.manifest.added.length));
}

function printList() {
  const backups = listBackups();
  if (!backups.length) {
    log.info('Бэкапов пока нет — они создаются автоматически при import/pull');
    return backups;
  }
  log.title('Бэкапы (новые сверху):');
  backups.forEach((b, i) => {
    const added = b.manifest ? b.manifest.added.length : 0;
    const src = b.manifest && b.manifest.source ? `  ← ${b.manifest.source}` : '';
    console.log(`  ${i + 1}. ${b.time}  —  перезаписано: ${b.files.length}, добавлено: ${added}${src}`);
    for (const f of b.files) log.dim('       ~ ' + f);
    if (b.manifest) for (const f of b.manifest.added) log.dim('       + ' + f);
  });
  return backups;
}

/**
 * Восстанавливает бэкап «до байта»: перезаписанные файлы возвращаются,
 * добавленные импортом — удаляются (по манифесту).
 */
function restore(nameOrIndex, opts = {}) {
  const backups = listBackups();
  if (!backups.length) {
    log.err('Бэкапов нет — восстанавливать нечего');
    process.exit(1);
  }

  let backup;
  if (!nameOrIndex) {
    backup = backups[0];
  } else if (/^\d+$/.test(nameOrIndex)) {
    backup = backups[Number(nameOrIndex) - 1];
  } else {
    backup = backups.find((b) => b.name === nameOrIndex || b.name === 'ccsync-' + nameOrIndex);
  }
  if (!backup) {
    log.err(`Бэкап не найден: ${nameOrIndex}. Список: ccsync backups`);
    process.exit(1);
  }

  log.info(`Восстановление из бэкапа ${backup.time}${opts.dryRun ? ' (dry-run)' : ''}:`);

  // 1. вернуть перезаписанные
  for (const rel of backup.files) {
    // .claude.json бэкапится из корня HOME, остальное — из ~/.claude
    const target = rel === '.claude.json' ? cfg.CLAUDE_JSON : path.join(cfg.CLAUDE_DIR, rel);
    if (opts.dryRun) {
      log.ok(`восстановить: ${rel}`);
      continue;
    }
    ensureDir(path.dirname(target));
    fs.copyFileSync(path.join(backup.dir, rel), target);
    if (!cfg.IS_WIN && rel.endsWith('.sh')) {
      try { fs.chmodSync(target, 0o755); } catch {}
    }
    log.ok('восстановлен: ' + rel);
  }

  // 2. удалить добавленные импортом (строгий откат по манифесту)
  const added = backup.manifest ? backup.manifest.added : [];
  for (const rel of added) {
    const target = path.join(cfg.CLAUDE_DIR, rel);
    if (!fs.existsSync(target)) continue;
    if (opts.dryRun) {
      log.info(`удалить (был добавлен импортом): ${rel}`);
      continue;
    }
    fs.unlinkSync(target);
    log.ok('удалён: ' + rel);
  }

  if (!opts.dryRun && !backup.manifest) {
    log.warn('Старый бэкап без манифеста: добавленные импортом файлы (если были) не удалены');
  }
  if (!opts.dryRun) log.ok('Откат завершён');
}

module.exports = { listBackups, printList, restore };
