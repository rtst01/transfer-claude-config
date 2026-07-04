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

// ── export / import + адаптация путей и merge ────────────────────────────
console.log('\n== export/import ==');
const plain = path.join(ROOT, 'plain.ccsync');
let r = run(src, ['export', plain]);
check('export ok', r.code === 0 && fs.existsSync(plain), r.out);
check('сигнатура CCSYNC1', fs.readFileSync(plain).subarray(0, 8).toString() === 'CCSYNC1\n');

const a = mkHome('a');
// локальные дополнения, которые merge обязан сохранить
writeJson(path.join(a, '.claude', 'settings.json'), {
  env: { LOCAL_ONLY: 'yes' },
  permissions: { allow: ['Bash(local-custom:*)'] },
  theme: 'light',
});
r = run(a, ['import', plain, '--dry-run']);
check('import --dry-run ok', r.code === 0 && /dry-run/i.test(r.out), r.out);
r = run(a, ['import', plain]);
check('import ok', r.code === 0, r.out);

const aSettings = readJson(path.join(a, '.claude', 'settings.json'));
check('пути адаптированы под новый home', JSON.stringify(aSettings).includes(a.replace(/\\/g, '\\\\')) || JSON.stringify(aSettings).includes(a));
check('старый home не остался', !JSON.stringify(aSettings).includes(src.replace(/\\/g, '\\\\') + path.sep === src ? src : src));
check('merge: локальный env сохранён', aSettings.env.LOCAL_ONLY === 'yes' && aSettings.env.SHARED === '1');
check('merge: локальное правило permissions сохранено', aSettings.permissions.allow.includes('Bash(local-custom:*)'));
check('merge: входящие permissions на месте', aSettings.permissions.allow.includes('Bash(git:*)'));
check('входящая theme победила', aSettings.theme === 'dark');
check('агент приехал', fs.existsSync(path.join(a, '.claude', 'agents', 'test-agent.md')));
check('mcpServers смержены', !!readJson(path.join(a, '.claude.json')).mcpServers.ctx);

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
check('diff после pull — чисто', r.code === 0 && /Отличий .* нет|^$/m.test(r.out), r.out);
// повторный pull после status (worktree должен быть чистым)
r = run(b, ['pull']);
check('pull после status работает', r.code === 0, r.out);

// ── backups / restore ────────────────────────────────────────────────────
console.log('\n== backups/restore ==');
const marker = readJson(path.join(b, '.claude', 'settings.json'));
marker.theme = 'MARKER_OLD';
writeJson(path.join(b, '.claude', 'settings.json'), marker);
r = run(b, ['import', plain, '--overwrite']);
check('import --overwrite ok', r.code === 0, r.out);
check('маркер затёрт', readJson(path.join(b, '.claude', 'settings.json')).theme === 'dark');
r = run(b, ['backups']);
check('backups список не пуст', /settings\.json/.test(r.out), r.out);
r = run(b, ['restore']);
check('restore ok', r.code === 0, r.out);
check('маркер вернулся', readJson(path.join(b, '.claude', 'settings.json')).theme === 'MARKER_OLD');

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
