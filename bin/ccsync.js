#!/usr/bin/env node
'use strict';

const { log } = require('../lib/util');
const { exportBundle, readBundle } = require('../lib/bundle');
const { apply, printReport } = require('../lib/apply');
const gitSync = require('../lib/git');

const HELP = `
ccsync — синхронизация настроек Claude Code между машинами (Windows / macOS / Linux)

Синхронизируется: settings.json, CLAUDE.md, keybindings.json, statusline.sh,
agents/, skills/, commands/, mcpServers (из ~/.claude.json)
Не трогается: settings.local.json, история, сессии, кэш, плагины

Через архив (разовый перенос):
  ccsync export [файл]           создать архив .ccsync с конфигурацией
  ccsync import <файл>           применить архив на этой машине (с бэкапом)
  ccsync import <файл> --dry-run посмотреть план без изменений

Через git (постоянная синхронизация):
  ccsync init [url]              настроить синхронизацию (клонировать приватный репо)
  ccsync push [-m "сообщение"]   выгрузить конфиг в репо и запушить
  ccsync pull [--dry-run]        забрать из репо и применить (с бэкапом)
  ccsync status                  показать отличия локального конфига от репо

Бэкапы (создаются автоматически при import/pull):
  ccsync backups                 список бэкапов с содержимым
  ccsync restore [N|имя]         откатить последний (или выбранный) бэкап
  ccsync restore --dry-run       посмотреть, что будет восстановлено

Интерфейсы:
  ccsync                         интерактивное меню в терминале
  ccsync ui                      веб-панель в браузере (localhost)

При применении на другой ОС автоматически:
  • пути /Users/... ⇄ C:\\Users\\... переводятся под текущую систему
  • bash-артефакты (statusline.sh) не ставятся на Windows без Git Bash
  • хуки с unix-командами помечаются предупреждением
  • перед изменениями делается бэкап в ~/.claude/backups/
`;

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = argv.slice(1).filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const dryRun = flags.has('--dry-run');

  switch (cmd) {
    case 'export':
      exportBundle(args[0]);
      break;

    case 'import': {
      if (!args[0]) {
        log.err('Укажи файл: ccsync import <файл.ccsync>');
        process.exit(1);
      }
      const bundle = readBundle(args[0]);
      log.info(
        `Архив от ${bundle.meta.hostname} (${bundle.meta.platform}), ` +
          `создан ${bundle.meta.createdAt.slice(0, 16).replace('T', ' ')}`
      );
      const report = apply(bundle, { dryRun });
      printReport(report, dryRun);
      break;
    }

    case 'init':
      gitSync.init(args[0]);
      break;

    case 'push': {
      const mIdx = argv.indexOf('-m');
      const msg = mIdx !== -1 ? argv[mIdx + 1] : undefined;
      gitSync.push(msg);
      break;
    }

    case 'pull': {
      const bundle = gitSync.pull();
      log.info(
        `Конфигурация от ${bundle.meta.hostname} (${bundle.meta.platform}), ` +
          `обновлена ${String(bundle.meta.createdAt).slice(0, 16).replace('T', ' ')}`
      );
      const report = apply(bundle, { dryRun });
      printReport(report, dryRun);
      break;
    }

    case 'status':
      gitSync.status();
      break;

    case 'backups':
      require('../lib/backups').printList();
      break;

    case 'restore':
      require('../lib/backups').restore(args[0], { dryRun });
      break;

    case 'ui':
      require('../lib/webui').startServer();
      break;

    case 'menu':
      require('../lib/tui').tui();
      break;

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;

    case undefined:
      // без аргументов: в терминале — интерактивное меню, иначе — справка
      if (process.stdin.isTTY && process.stdout.isTTY) require('../lib/tui').tui();
      else console.log(HELP);
      break;

    default:
      log.err(`Неизвестная команда: ${cmd}`);
      console.log(HELP);
      process.exit(1);
  }
}

main();
