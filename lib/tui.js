'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawnSync } = require('child_process');
const cfg = require('./config');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const cyan = (s) => c('36', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);

function ask(rl, q) {
  return new Promise((res) => rl.question(q, res));
}

/** Путь из drag-n-drop в терминал: кавычки и экранированные пробелы. */
function cleanPath(p) {
  return p.trim().replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ');
}

function runCli(args) {
  console.log();
  spawnSync(cfg.SELF.exec, [...cfg.SELF.args, ...args], { stdio: 'inherit' });
  console.log();
}

function countDir(rel) {
  try {
    return fs.readdirSync(path.join(cfg.CLAUDE_DIR, rel)).filter((f) => !f.startsWith('.')).length;
  } catch {
    return 0;
  }
}

function countPlugins() {
  try {
    const installed = JSON.parse(
      fs.readFileSync(path.join(cfg.CLAUDE_DIR, 'plugins', 'installed_plugins.json'), 'utf8')
    );
    return Object.keys(installed.plugins || {}).length;
  } catch {
    return 0;
  }
}

function header() {
  const state = cfg.readState();
  let repoLine = dim('не настроен — пункт 6');
  if (state.repoDir && fs.existsSync(path.join(state.repoDir, '.git'))) {
    const r = spawnSync('git', ['-C', state.repoDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
    repoLine = r.status === 0 ? green(r.stdout.trim()) : yellow(state.repoDir + ' (без remote)');
  }
  const mcp = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(cfg.CLAUDE_JSON, 'utf8'));
      return Object.keys(j.mcpServers || {}).length;
    } catch {
      return 0;
    }
  })();

  console.clear();
  const { VERSION } = require('./update');
  console.log(bold(cyan('  ccsync')) + dim(` v${VERSION}  —  Claude Code Sync   ${process.platform} · ${os.hostname().split('.')[0]}`));
  console.log(dim('  ─────────────────────────────────────────────'));
  console.log(`  Репозиторий: ${repoLine}`);
  console.log(
    `  Агенты: ${bold(countDir('agents'))}   Скиллы: ${bold(countDir('skills'))}   ` +
      `Команды: ${bold(countDir('commands'))}   MCP: ${bold(mcp)}   Плагины: ${bold(countPlugins())}`
  );
  console.log(dim('  ─────────────────────────────────────────────'));
}

const MENU = `
  ${bold('1')}. Статус / дифф — что изменилось
  ${bold('2')}. Push — отправить конфиг в репо
  ${bold('3')}. Pull — забрать из репо и применить
  ${bold('4')}. Экспорт в архив (.ccsync)
  ${bold('5')}. Импорт из архива
  ${bold('6')}. Настроить git-синхронизацию
  ${bold('7')}. Бэкапы / восстановление
  ${bold('8')}. Авто-синхронизация (хуки Claude Code)
  ${bold('9')}. Открыть веб-панель
  ${bold('l')}. История синхронизаций   ${bold('d')}. Диагностика   ${bold('u')}. Обновить ccsync
  ${bold('q')}. Выход
`;

async function tui() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  for (;;) {
    header();
    console.log(MENU);
    const choice = (await ask(rl, '  Выбор: ')).trim().toLowerCase();

    switch (choice) {
      case '1': {
        runCli(['status']);
        const d = (await ask(rl, '  Показать подробный дифф? [y/N]: ')).trim().toLowerCase();
        if (d === 'y' || d === 'д') runCli(['diff']);
        break;
      }
      case '2': {
        const msg = (await ask(rl, '  Сообщение коммита (Enter — авто): ')).trim();
        runCli(msg ? ['push', '-m', msg] : ['push']);
        break;
      }
      case '3': {
        const dry = (await ask(rl, '  Сначала dry-run? [Y/n]: ')).trim().toLowerCase();
        if (dry !== 'n' && dry !== 'н') {
          runCli(['pull', '--dry-run']);
          const go = (await ask(rl, '  Применить? [y/N]: ')).trim().toLowerCase();
          if (go !== 'y' && go !== 'д') break;
        }
        runCli(['pull']);
        break;
      }
      case '4': {
        const out = (await ask(rl, '  Имя файла (Enter — авто): ')).trim();
        const enc = (await ask(rl, '  Зашифровать паролем? [y/N]: ')).trim().toLowerCase();
        const extra = enc === 'y' || enc === 'д' ? ['--encrypt'] : [];
        runCli(out ? ['export', cleanPath(out), ...extra] : ['export', ...extra]);
        break;
      }
      case '5': {
        const file = cleanPath(await ask(rl, '  Путь к .ccsync (можно перетащить файл сюда): '));
        if (!file) break;
        runCli(['import', file, '--dry-run']);
        const go = (await ask(rl, '  Применить? [y/N]: ')).trim().toLowerCase();
        if (go === 'y' || go === 'д') runCli(['import', file]);
        break;
      }
      case '6': {
        const url = (await ask(rl, '  URL приватного репо (Enter — локальный без remote): ')).trim();
        runCli(url ? ['init', url] : ['init']);
        break;
      }
      case '7': {
        runCli(['backups']);
        const n = (await ask(rl, '  Номер бэкапа для отката (Enter — отмена): ')).trim();
        if (n) {
          runCli(['restore', n, '--dry-run']);
          const go = (await ask(rl, '  Восстановить? [y/N]: ')).trim().toLowerCase();
          if (go === 'y' || go === 'д') runCli(['restore', n]);
        }
        break;
      }
      case '8': {
        runCli(['autosync']);
        const t = (await ask(rl, '  Включить (on) / выключить (off) / Enter — назад: ')).trim().toLowerCase();
        if (t === 'on' || t === 'off') runCli(['autosync', t]);
        break;
      }
      case '9':
        rl.close();
        require('./webui').startServer();
        return; // сервер держит процесс
      case 'l':
      case 'д':
        runCli(['log']);
        break;
      case 'd':
      case 'в':
        runCli(['doctor']);
        break;
      case 'u':
      case 'г':
        runCli(['update']);
        break;
      case 'q':
      case 'й':
        rl.close();
        return;
      default:
        continue;
    }
    await ask(rl, dim('  Enter — в меню… '));
  }
}

module.exports = { tui };
