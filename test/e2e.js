'use strict';

/**
 * Сквозной тест ccsync: export → import(+merge) → шифрование → git push/pull →
 * status/diff → backups/restore → autosync. Гоняется на win/mac/linux в CI.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'ccsync.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsync-e2e-'));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}\n${detail}`);
  }
}

function run(home, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CCSYNC_HOME: home, ...env },
  });
  return { code: r.status, out: stripAnsi((r.stdout || '') + (r.stderr || '')) };
}

function mkHome(name) {
  const home = path.join(ROOT, name);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// Распаковывает .ccsync (gzip-JSON, MAGIC CCSYNC1\n) для инспекции содержимого бандла.
const readCcsync = (f) =>
  JSON.parse(require('zlib').gunzipSync(fs.readFileSync(f).subarray('CCSYNC1\n'.length)).toString('utf8'));

// ── юнит: нормализация путей (Windows-кейсы гоняем на любой ОС) ──────────
console.log('== normalizeHome ==');
const { normalizeHome } = require('../lib/util');
check(
  'win-путь целиком',
  normalizeHome('C:\\Users\\x\\.claude\\statusline.sh', 'C:\\Users\\x') === '~/.claude/statusline.sh'
);
check(
  'win-путь внутри команды',
  normalizeHome('bash C:\\Users\\x\\.claude\\run.sh --flag', 'C:\\Users\\x') === 'bash ~/.claude/run.sh --flag'
);
check(
  'смешанные слэши',
  normalizeHome('C:/Users/x/.claude/a.md', 'C:\\Users\\x') === '~/.claude/a.md'
);
check('unix-путь', normalizeHome('/Users/y/.claude/a.md', '/Users/y') === '~/.claude/a.md');
check('чужой путь не тронут', normalizeHome('/opt/tool/bin', '/Users/y') === '/opt/tool/bin');

// ── фикстура: исходная машина ────────────────────────────────────────────
const src = mkHome('src');
writeJson(path.join(src, '.claude', 'settings.json'), {
  env: { SHARED: '1' },
  permissions: { allow: ['Bash(git:*)', 'Bash(npm:*)'], defaultMode: 'default' },
  statusLine: { type: 'command', command: `bash ${path.join(src, '.claude', 'statusline.sh')}` },
  theme: 'dark',
  model: 'opus',
});
fs.writeFileSync(path.join(src, '.claude', 'CLAUDE.md'), '# память\n');
fs.mkdirSync(path.join(src, '.claude', 'agents'), { recursive: true });
fs.writeFileSync(path.join(src, '.claude', 'agents', 'test-agent.md'), '---\nname: test\n---\nагент\n');
fs.writeFileSync(path.join(src, '.claude', 'statusline.sh'), '#!/bin/bash\necho ok\n');
writeJson(path.join(src, '.claude.json'), {
  someHistory: ['not synced'],
  mcpServers: { ctx: { command: 'npx', args: ['-y', 'ctx-server', path.join(src, 'data')] } },
});
// плагины: переносим только идентификаторы, локальные пути должны быть отброшены
writeJson(path.join(src, '.claude', 'plugins', 'installed_plugins.json'), {
  version: 2,
  plugins: {
    'commit-commands@claude-plugins-official': [
      { scope: 'user', installPath: path.join(src, '.claude', 'plugins', 'cache', 'commit'), version: '1.0.0' },
    ],
  },
});
writeJson(path.join(src, '.claude', 'plugins', 'known_marketplaces.json'), {
  'claude-plugins-official': {
    source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
    installLocation: path.join(src, '.claude', 'plugins', 'marketplaces', 'official'),
    lastUpdated: '2026-01-01T00:00:00Z',
  },
});
// скилы: обычный каталог + скил-симлинк (частый случай на Windows — junction
// от инсталляторов вроде find-skills; walkDir обязан идти по ссылке)
fs.mkdirSync(path.join(src, '.claude', 'skills', 'plain-skill'), { recursive: true });
fs.writeFileSync(path.join(src, '.claude', 'skills', 'plain-skill', 'SKILL.md'), '# plain\n');
const linkTarget = path.join(ROOT, 'linked-skill-target');
fs.mkdirSync(linkTarget, { recursive: true });
fs.writeFileSync(path.join(linkTarget, 'SKILL.md'), '# linked\n');
let symlinksOk = true;
try {
  fs.symlinkSync(linkTarget, path.join(src, '.claude', 'skills', 'linked-skill'),
    process.platform === 'win32' ? 'junction' : 'dir');
  // битая ссылка не должна ронять сбор
  fs.symlinkSync(path.join(ROOT, 'no-such-dir'), path.join(src, '.claude', 'skills', 'broken-skill'),
    process.platform === 'win32' ? 'junction' : 'dir');
} catch {
  symlinksOk = false; // нет прав на симлинки — кейс пропускаем
}

// ── export / import + адаптация путей и merge ────────────────────────────
console.log('\n== export/import ==');
const plain = path.join(ROOT, 'plain.ccsync');
let r = run(src, ['export', plain]);
check('export ok', r.code === 0 && fs.existsSync(plain), r.out);
check('сигнатура CCSYNC1', fs.readFileSync(plain).subarray(0, 8).toString() === 'CCSYNC1\n');

// collect: список плагинов попал в бандл, локальные пути отброшены
const srcBundle = readCcsync(plain);
check('collect: обычный скил в бандле', 'skills/plain-skill/SKILL.md' in srcBundle.files);
if (symlinksOk) {
  check(
    'collect: скил-симлинк разыменован и попал в бандл',
    'skills/linked-skill/SKILL.md' in srcBundle.files,
    Object.keys(srcBundle.files).filter((f) => f.startsWith('skills/')).join(', ')
  );
  check(
    'collect: битая ссылка пропущена без ошибки',
    !Object.keys(srcBundle.files).some((f) => f.includes('broken-skill'))
  );
}
check(
  'collect: bundle.plugins содержит идентификатор',
  !!srcBundle.plugins && srcBundle.plugins.plugins.includes('commit-commands@claude-plugins-official'),
  JSON.stringify(srcBundle.plugins)
);
check(
  'collect: маркетплейс без локальных путей',
  !!srcBundle.plugins &&
    srcBundle.plugins.marketplaces['claude-plugins-official'].source.repo === 'anthropics/claude-plugins-official' &&
    !/installLocation|installPath|lastUpdated/.test(JSON.stringify(srcBundle.plugins)),
  JSON.stringify(srcBundle.plugins)
);

const a = mkHome('a');
// локальные дополнения, которые merge обязан сохранить
writeJson(path.join(a, '.claude', 'settings.json'), {
  env: { LOCAL_ONLY: 'yes' },
  permissions: { allow: ['Bash(local-custom:*)'] },
  theme: 'light',
});
r = run(a, ['import', plain, '--dry-run']);
check('import --dry-run ok', r.code === 0 && /dry-run/i.test(r.out), r.out);
check('import --dry-run показывает план плагинов', /плагины к установке/.test(r.out) && /plugin install commit-commands@claude-plugins-official/.test(r.out), r.out);
r = run(a, ['import', plain]);
check('import ok', r.code === 0, r.out);
// боевой режим: гард CCSYNC_HOME не даёт выполнять claude — команды только для ручного запуска
check('боевой import: гард CCSYNC_HOME не ставит плагины', /CCSYNC_HOME/.test(r.out), r.out);
check('боевой import: побочных эффектов нет (installed_plugins.json не создан)', !fs.existsSync(path.join(a, '.claude', 'plugins', 'installed_plugins.json')), r.out);

const aSettings = readJson(path.join(a, '.claude', 'settings.json'));
check('пути адаптированы под новый home', JSON.stringify(aSettings).includes(a.replace(/\\/g, '\\\\')) || JSON.stringify(aSettings).includes(a));
check('старый home не остался', !JSON.stringify(aSettings).includes(src.replace(/\\/g, '\\\\') + path.sep === src ? src : src));
check('merge: локальный env сохранён', aSettings.env.LOCAL_ONLY === 'yes' && aSettings.env.SHARED === '1');
check('merge: локальное правило permissions сохранено', aSettings.permissions.allow.includes('Bash(local-custom:*)'));
check('merge: входящие permissions на месте', aSettings.permissions.allow.includes('Bash(git:*)'));
check('входящая theme победила', aSettings.theme === 'dark');
check('агент приехал', fs.existsSync(path.join(a, '.claude', 'agents', 'test-agent.md')));
check('mcpServers смержены', !!readJson(path.join(a, '.claude.json')).mcpServers.ctx);

// ── mcpServers при переносе между разными ОС ─────────────────────────────
console.log('\n== кросс-платформенный merge mcpServers ==');
const x = mkHome('x');
writeJson(path.join(x, '.claude.json'), {
  mcpServers: { keepme: { type: 'stdio', command: 'npx', args: ['-y', 'local-good-server'] } },
});
// бандл «с другой ОС»: одноимённый сервер, cmd-обёртка, windows-бинарь
const otherPlatform = process.platform === 'win32' ? 'darwin' : 'win32';
const crossBundle = {
  meta: { version: 1, createdAt: '2026-01-01T00:00:00Z', platform: otherPlatform, hostname: 'other', home: otherPlatform === 'win32' ? 'C:\\Users\\o' : '/Users/o' },
  files: {},
  mcpServers: {
    keepme: { type: 'stdio', command: 'cmd', args: ['/c', 'npx', 'foreign-version'] },
    wrapped: { type: 'stdio', command: 'cmd', args: ['/c', 'npx', '-y', 'some-tool'], env: { LOCALAPPDATA: 'C:\\x', KEEP: '1' } },
    binsrv: { type: 'stdio', command: 'C:\\tools\\srv-windows-x64.exe', args: [] },
  },
};
const crossFile = path.join(ROOT, 'cross.ccsync');
fs.writeFileSync(crossFile, Buffer.concat([
  Buffer.from('CCSYNC1\n'),
  require('zlib').gzipSync(Buffer.from(JSON.stringify(crossBundle), 'utf8')),
]));
r = run(x, ['import', crossFile]);
check('кросс-импорт ok', r.code === 0, r.out);
const xMcp = readJson(path.join(x, '.claude.json')).mcpServers;
check('одноимённый сервер: локальное определение сохранено',
  xMcp.keepme.command === 'npx' && xMcp.keepme.args.includes('local-good-server'), JSON.stringify(xMcp.keepme));
if (process.platform !== 'win32') {
  check('cmd-обёртка снята у нового сервера',
    xMcp.wrapped.command === 'npx' && xMcp.wrapped.args[0] === '-y', JSON.stringify(xMcp.wrapped));
  check('windows-env вычищен, остальной сохранён',
    !('LOCALAPPDATA' in xMcp.wrapped.env) && xMcp.wrapped.env.KEEP === '1', JSON.stringify(xMcp.wrapped.env));
  check('windows-бинарь пропущен с предупреждением',
    !xMcp.binsrv && /windows-бинарь/.test(r.out), r.out);
} else {
  check('cmd-обёртка нового сервера сохранена на Windows', xMcp.wrapped.command === 'cmd', JSON.stringify(xMcp.wrapped));
}

// ── шифрование ───────────────────────────────────────────────────────────
console.log('\n== шифрование ==');
const enc = path.join(ROOT, 'enc.ccsync');
r = run(src, ['export', enc, '--encrypt'], { CCSYNC_PASSPHRASE: 'secret123' });
check('export --encrypt ok', r.code === 0 && fs.existsSync(enc), r.out);
check('сигнатура CCSYNCE1', fs.readFileSync(enc).subarray(0, 9).toString() === 'CCSYNCE1\n');

const e = mkHome('e');
r = run(e, ['import', enc, '--dry-run'], { CCSYNC_PASSPHRASE: 'wrong' });
check('неверный пароль отвергнут', r.code !== 0 && /расшифровать/i.test(r.out), r.out);
r = run(e, ['import', enc], { CCSYNC_PASSPHRASE: 'secret123' });
check('верный пароль применяет архив', r.code === 0 && fs.existsSync(path.join(e, '.claude', 'settings.json')), r.out);

// ── git: init / push / pull / status / diff ──────────────────────────────
console.log('\n== git-синхронизация ==');
const bare = path.join(ROOT, 'remote.git');
spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' });

r = run(a, ['init', bare]);
check('init(clone) ok', r.code === 0, r.out);
r = run(a, ['push']);
check('первый push ok', r.code === 0 && /Отправлено|Коммит/.test(r.out), r.out);
r = run(a, ['push']);
check('повторный push — изменений нет', /Изменений нет/.test(r.out), r.out);

const b = mkHome('b');
r = run(b, ['init', bare]);
check('init на машине B ok', r.code === 0, r.out);
r = run(b, ['pull']);
check('pull применил конфиг', r.code === 0 && fs.existsSync(path.join(b, '.claude', 'agents', 'test-agent.md')), r.out);
const bSettings = readJson(path.join(b, '.claude', 'settings.json'));
check('пути на B адаптированы', JSON.stringify(bSettings).includes(b) || JSON.stringify(bSettings).includes(b.replace(/\\/g, '\\\\')));

r = run(b, ['status']);
check('status после pull — совпадает', r.code === 0 && /совпадает/.test(r.out), r.out);
r = run(b, ['diff']);
check('diff после pull — чисто', r.code === 0 && /Отличий от репозитория нет/.test(r.out), r.out);
// повторный pull после status (worktree должен быть чистым)
r = run(b, ['pull']);
check('pull после status работает', r.code === 0, r.out);

// эмуляция Windows: autocrlf=true + CRLF-checkout не должны давать фантомных "M"
const bRepo = path.join(b, '.claude-sync');
spawnSync('git', ['-C', bRepo, 'config', 'core.autocrlf', 'true'], { encoding: 'utf8' });
fs.rmSync(path.join(bRepo, 'claude'), { recursive: true, force: true });
spawnSync('git', ['-C', bRepo, 'checkout', '-f', 'HEAD'], { encoding: 'utf8' });
r = run(b, ['status']);
check('status с autocrlf (эмуляция Windows) — совпадает', r.code === 0 && /совпадает/.test(r.out), r.out);

// ── backups / строгий restore ────────────────────────────────────────────
console.log('\n== backups/restore ==');
const marker = readJson(path.join(b, '.claude', 'settings.json'));
marker.theme = 'MARKER_OLD';
writeJson(path.join(b, '.claude', 'settings.json'), marker);
// файл, которого не было на B, — импорт его добавит, строгий откат должен удалить
fs.rmSync(path.join(b, '.claude', 'CLAUDE.md'), { force: true });
r = run(b, ['import', plain, '--overwrite']);
check('import --overwrite ok', r.code === 0, r.out);
check('маркер затёрт', readJson(path.join(b, '.claude', 'settings.json')).theme === 'dark');
check('CLAUDE.md добавлен импортом', fs.existsSync(path.join(b, '.claude', 'CLAUDE.md')));
r = run(b, ['backups']);
check('backups список не пуст', /settings\.json/.test(r.out), r.out);
check('манифест показывает добавленные', /\+ CLAUDE\.md/.test(r.out), r.out);
r = run(b, ['restore', '--dry-run']);
check('restore dry-run показывает удаление', /удалить.*CLAUDE\.md/.test(r.out), r.out);
r = run(b, ['restore']);
check('restore ok', r.code === 0, r.out);
check('маркер вернулся', readJson(path.join(b, '.claude', 'settings.json')).theme === 'MARKER_OLD');
check('строгий откат: добавленный файл удалён', !fs.existsSync(path.join(b, '.claude', 'CLAUDE.md')));

// ── log / version / doctor ───────────────────────────────────────────────
console.log('\n== log/version/doctor ==');
r = run(b, ['log']);
check('log показывает историю', r.code === 0 && /sync from/.test(r.out), r.out);
r = run(b, ['version']);
check('version ok', r.code === 0 && /ccsync v\d+\.\d+\.\d+/.test(r.out), r.out);
r = run(b, ['doctor']);
check('doctor отрабатывает', r.code === 0 && /git установлен/.test(r.out), r.out);

// ── autosync ─────────────────────────────────────────────────────────────
console.log('\n== autosync ==');
r = run(a, ['autosync', 'on']);
check('autosync on ok', r.code === 0, r.out);
const hooked = readJson(path.join(a, '.claude', 'settings.json'));
check('хук SessionStart добавлен', JSON.stringify(hooked.hooks.SessionStart).includes('ccsync autopull'));
check('хук SessionEnd добавлен', JSON.stringify(hooked.hooks.SessionEnd).includes('ccsync autopush'));
r = run(a, ['autopull']);
check('autopull тихий и не падает', r.code === 0 && r.out.trim() === '', r.out);
r = run(a, ['autosync', 'off']);
check('autosync off убирает хуки', !JSON.stringify(readJson(path.join(a, '.claude', 'settings.json'))).includes('ccsync autopull'));

// ── итог ─────────────────────────────────────────────────────────────────
console.log(`\nПройдено: ${passed}, провалено: ${failed}`);
try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch {}
process.exit(failed ? 1 : 0);
