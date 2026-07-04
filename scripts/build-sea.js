'use strict';

/**
 * Сборка standalone-бинаря через Node SEA (Single Executable Application).
 * Кроссплатформенный: гоняется в CI на ubuntu/macos/windows.
 *
 *   node scripts/build-sea.js  →  dist/ccsync-<os>-<arch>[.exe]
 *
 * Этапы: esbuild-бандл → SEA-blob (panel.html как ассет) → копия node →
 * postject-инъекция → подпись (macOS) → smoke-тест.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const run = (cmd) => {
  console.log('$ ' + cmd);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
};

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. бандл в один CommonJS-файл
run('npx --yes esbuild@0.24.2 bin/ccsync.js --bundle --platform=node --target=node20 --outfile=dist/ccsync.cjs');

// 2. SEA-blob с panel.html как встроенным ассетом
const seaConfig = {
  main: path.join(DIST, 'ccsync.cjs'),
  output: path.join(DIST, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  assets: { 'panel.html': path.join(ROOT, 'lib', 'panel.html') },
};
const seaConfigPath = path.join(DIST, 'sea-config.json');
fs.writeFileSync(seaConfigPath, JSON.stringify(seaConfig, null, 2));
run(`"${process.execPath}" --experimental-sea-config "${seaConfigPath}"`);

// 3. копия node-рантайма → наш бинарь
const platName = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
const outName = `ccsync-${platName}-${process.arch}${IS_WIN ? '.exe' : ''}`;
const out = path.join(DIST, outName);
fs.copyFileSync(process.execPath, out);

// 4. инъекция blob (на macOS сначала снимаем подпись, после — ad-hoc подпись).
// Universal-бинарь node (x64+arm64) содержит сентинел дважды — берём нативный слайс.
if (IS_MAC) {
  const archs = execSync(`lipo -archs "${out}"`, { encoding: 'utf8' }).trim().split(/\s+/);
  if (archs.length > 1) run(`lipo "${out}" -thin ${process.arch === 'arm64' ? 'arm64' : 'x86_64'} -output "${out}"`);
  run(`codesign --remove-signature "${out}"`);
}
run(
  `npx --yes postject "${out}" NODE_SEA_BLOB "${seaConfig.output}" ` +
    `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` +
    (IS_MAC ? ' --macho-segment-name NODE_SEA' : '')
);
if (IS_MAC) run(`codesign --sign - "${out}"`);
if (!IS_WIN) fs.chmodSync(out, 0o755);

// 5. smoke-тест: справка + export во временный home
console.log('\n== smoke-тест бинаря ==');
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsync-sea-'));
fs.mkdirSync(path.join(fakeHome, '.claude', 'agents'), { recursive: true });
fs.writeFileSync(path.join(fakeHome, '.claude', 'settings.json'), '{"theme":"dark"}');
fs.writeFileSync(path.join(fakeHome, '.claude', 'agents', 'a.md'), 'agent');

const help = execSync(`"${out}" help`, { encoding: 'utf8' });
if (!help.includes('ccsync')) throw new Error('smoke: help не отработал');
const archive = path.join(fakeHome, 'test.ccsync');
execSync(`"${out}" export "${archive}"`, {
  encoding: 'utf8',
  env: { ...process.env, CCSYNC_HOME: fakeHome },
});
if (!fs.existsSync(archive)) throw new Error('smoke: export не создал архив');
fs.rmSync(fakeHome, { recursive: true, force: true });

const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ Готово: dist/${outName} (${mb} MB)`);
