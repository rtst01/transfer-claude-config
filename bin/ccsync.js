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
    --encrypt                    зашифровать паролем (AES-256-GCM)
  ccsync import <файл>           применить архив на этой машине (с бэкапом)
    --dry-run                    посмотреть план без изменений
    --overwrite                  перезаписать настройки без merge с локальными
    --password=…                 пароль зашифрованного архива (или CCSYNC_PASSPHRASE)

Через git (постоянная синхронизация):
  ccsync init [url]              настроить синхронизацию (клонировать приватный репо)
  ccsync push [-m "сообщение"]   выгрузить конфиг в репо и запушить
  ccsync pull [--dry-run]        забрать из репо и применить (merge + бэкап)
  ccsync status                  краткие отличия локального конфига от репо
  ccsync diff [файл.ccsync]      подробный дифф против репо или архива

Авто-синхронизация (хуки Claude Code):
  ccsync autosync on|off|status  pull при старте сессии, push при завершении

Бэкапы (создаются автоматически при import/pull):
  ccsync backups                 список бэкапов с содержимым
  ccsync restore [N|имя]         строгий откат: вернуть перезаписанное,
                                 удалить добавленное импортом (--dry-run — план)

Сервис:
  ccsync log [N]                 история синхронизаций (кто/когда/что пушил)
  ccsync doctor                  диагностика окружения с рецептами
  ccsync update                  обновить ccsync до последней версии

Интерфейсы:
  ccsync                         интерактивное меню в терминале
  ccsync ui                      веб-панель в браузере (localhost)
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = argv.slice(1).filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]));
  const flagValue = (name) => {
    const f = argv.find((a) => a.startsWith(name + '='));
    return f ? f.slice(name.length + 1) : undefined;
  };
  const dryRun = flags.has('--dry-run');
  const overwrite = flags.has('--overwrite');
  const password = flagValue('--password');

  switch (cmd) {
    case 'export':
      await exportBundle(args[0], { encrypt: flags.has('--encrypt'), password });
      break;

    case 'import': {
      if (!args[0]) {
        log.err('Укажи файл: ccsync import <файл.ccsync>');
        process.exit(1);
      }
      const bundle = await readBundle(args[0], { password });
      log.info(
        `Архив от ${bundle.meta.hostname} (${bundle.meta.platform}), ` +
          `создан ${bundle.meta.createdAt.slice(0, 16).replace('T', ' ')}`
      );
      printReport(apply(bundle, { dryRun, overwrite }), dryRun);
      break;
    }

    case 'init':
      gitSync.init(args[0]);
      break;

    case 'push': {
      const mIdx = argv.indexOf('-m');
      gitSync.push(mIdx !== -1 ? argv[mIdx + 1] : undefined);
      break;
    }

    case 'pull': {
      const bundle = gitSync.pull();
      log.info(
        `Конфигурация от ${bundle.meta.hostname} (${bundle.meta.platform}), ` +
          `обновлена ${String(bundle.meta.createdAt).slice(0, 16).replace('T', ' ')}`
      );
      printReport(apply(bundle, { dryRun, overwrite }), dryRun);
      break;
    }

    case 'status':
      gitSync.status();
      await require('../lib/update').notifyIfOutdated();
      break;

    case 'log':
      gitSync.logCmd(args[0] ? Number(args[0]) : 15);
      break;

    case 'doctor':
      await require('../lib/doctor').doctor();
      break;

    case 'update':
      await require('../lib/update').selfUpdate();
      break;

    case 'version':
    case '--version':
    case '-v':
      console.log('ccsync v' + require('../lib/update').VERSION);
      break;

    case 'diff':
      if (args[0]) {
        require('../lib/diff').diffBundle(await readBundle(args[0], { password }));
      } else {
        gitSync.diffRepo();
      }
      break;

    case 'autosync': {
      const auto = require('../lib/autosync');
      if (args[0] === 'on') auto.enable();
      else if (args[0] === 'off') auto.disable();
      else auto.status();
      break;
    }

    // скрытые команды для хуков Claude Code: тихие, всегда exit 0
    case 'autopull':
      require('../lib/autosync').autopull();
      break;
    case 'autopush':
      require('../lib/autosync').autopush();
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

main().catch((e) => {
  log.err(e.message);
  process.exit(1);
});
