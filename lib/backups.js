'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { log, ensureDir, walkDir } = require('./util');

/** Список бэкапов ccsync, новые первыми. */
function listBackups() {
  if (!fs.existsSync(cfg.BACKUPS_DIR)) return [];
  return fs
    .readdirSync(cfg.BACKUPS_DIR)
    .filter((n) => n.startsWith('ccsync-'))
    .sort()
    .reverse()
    .map((name) => {
      const dir = path.join(cfg.BACKUPS_DIR, name);
      const files = walkDir(dir);
      // ccsync-YYYYMMDD-HHMMSS → "YYYY-MM-DD HH:MM:SS"
      const m = name.match(/^ccsync-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
      const time = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : name;
      return { name, dir, time, files };
    })
    .filter((b) => b.files.length > 0);
}

function printList() {
  const backups = listBackups();
  if (!backups.length) {
    log.info('Бэкапов пока нет — они создаются автоматически при import/pull');
    return backups;
  }
  log.title('Бэкапы (новые сверху):');
  backups.forEach((b, i) => {
    console.log(`  ${i + 1}. ${b.time}  —  ${b.files.length} файл(ов)`);
    for (const f of b.files) log.dim('       ' + f);
  });
  return backups;
}

/**
 * Восстанавливает бэкап: name — имя каталога, номер из списка или пусто (последний).
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
  for (const rel of backup.files) {
    // .claude.json бэкапится из корня HOME, остальное — из ~/.claude
    const target =
      rel === '.claude.json' ? cfg.CLAUDE_JSON : path.join(cfg.CLAUDE_DIR, rel);
    if (opts.dryRun) {
      log.ok(`${rel} → ${target}`);
      continue;
    }
    ensureDir(path.dirname(target));
    fs.copyFileSync(path.join(backup.dir, rel), target);
    if (!cfg.IS_WIN && rel.endsWith('.sh')) {
      try { fs.chmodSync(target, 0o755); } catch {}
    }
    log.ok(rel);
  }
  if (!opts.dryRun) {
    log.info('\nГотово. Файлы, добавленные импортом (которых не было раньше), не удаляются —');
    log.info('бэкап хранит только то, что перезаписывалось.');
  }
}

module.exports = { listBackups, printList, restore };
