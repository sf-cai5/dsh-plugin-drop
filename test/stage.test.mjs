/**
 * Checks for the staging pipeline: a real Windows-made ZIP, a folder drop, a
 * hand-built archive that tries to escape the extraction root, and package
 * validation. Run with: node test/stage.test.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, extractZip, isUnsafeEntryName } from '../lib/zip.js';
import { classifyDrop, inspectPluginDir, resolvePluginRoot, shouldSkip, stageDrop, writeDroppedFiles } from '../lib/stage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-drop-test-'));
let passed = 0;
function check(label, run) {
  run();
  passed += 1;
  console.log(`  ok  ${label}`);
}

/** Build a store-method ZIP in memory, so traversal and encodings can be tested exactly. */
function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

console.log('plugin-drop staging tests');

// ── a real folder, zipped by Windows, dropped as an archive ──────────────────
const source = path.join(root, 'source', 'repo-main');
fs.mkdirSync(path.join(source, 'lib'), { recursive: true });
fs.mkdirSync(path.join(source, 'node_modules', 'junk'), { recursive: true });
fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'probe-plugin', version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2));
fs.writeFileSync(path.join(source, 'lib', 'index.js'), 'export const name = "probe-plugin"\n');
fs.writeFileSync(path.join(source, 'cordis.patch.yml'), '- insert: []\n');
fs.writeFileSync(path.join(source, 'node_modules', 'junk', 'index.js'), 'ignored\n');
fs.writeFileSync(path.join(source, '.DS_Store'), 'noise\n');
const archivePath = path.join(root, 'probe.zip');
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${source}' -DestinationPath '${archivePath}' -Force`], { stdio: 'pipe' });

const stagingRoot = path.join(root, 'staging');
const zipPayload = { files: [{ path: 'probe.zip', data: fs.readFileSync(archivePath).toString('base64') }] };

check('a Windows-made ZIP is recognized as an archive', () => {
  assert.deepEqual(classifyDrop(['probe.zip']), { kind: 'zip' });
});
check('the archive is unpacked, its wrapper directory resolved, and noise skipped', () => {
  const staged = stageDrop(zipPayload, stagingRoot);
  assert.equal(staged.kind, 'directory');
  assert.equal(staged.inspection.name, 'probe-plugin');
  assert.equal(staged.inspection.version, '1.2.3');
  assert.equal(staged.inspection.hasBundlePatch, true);
  assert.equal(fs.existsSync(path.join(staged.pluginDirectory, 'lib', 'index.js')), true);
  assert.equal(fs.existsSync(path.join(staged.pluginDirectory, 'node_modules')), false, 'node_modules must not be staged');
  assert.equal(fs.existsSync(path.join(staged.pluginDirectory, '.DS_Store')), false, '.DS_Store must not be staged');
});

// ── a dropped folder, as the browser delivers it ────────────────────────────
const folderPayload = {
  files: [
    { path: 'repo-main/package.json', data: Buffer.from(JSON.stringify({ name: '@scope/dropped', version: '0.1.0', dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } })).toString('base64') },
    { path: 'repo-main/cordis.patch.yml', data: Buffer.from('- insert: []\n').toString('base64') },
    { path: 'repo-main/src/deep/file.js', data: Buffer.from('export default 1\n').toString('base64') },
    { path: 'repo-main/node_modules/dep/index.js', data: Buffer.from('ignored\n').toString('base64') },
  ],
};
check('a dropped folder is written with its tree intact', () => {
  assert.deepEqual(classifyDrop(folderPayload.files.map(file => file.path)), { kind: 'folder' });
  const staged = stageDrop(folderPayload, stagingRoot);
  assert.equal(staged.inspection.name, '@scope/dropped');
  assert.equal(staged.inspection.hasClient, true);
  assert.equal(staged.fileCount, 3);
  assert.equal(fs.existsSync(path.join(staged.pluginDirectory, 'src', 'deep', 'file.js')), true);
});

check('a package without a bundle patch warns instead of failing', () => {
  const staged = stageDrop({ files: [{ path: 'plain/package.json', data: Buffer.from(JSON.stringify({ name: 'plain-dep' })).toString('base64') }] }, stagingRoot);
  assert.equal(staged.inspection.hasBundlePatch, false);
  assert.match(staged.inspection.warnings.join(' '), /plain dependency/u);
});

check('content that is not a package is refused', () => {
  assert.throws(() => stageDrop({ files: [{ path: 'notes/readme.txt', data: Buffer.from('hello').toString('base64') }] }, stagingRoot), /no package\.json/u);
});
check('an empty drop is refused', () => {
  assert.throws(() => stageDrop({ files: [] }, stagingRoot), /nothing was dropped/u);
});

// ── archives that must not be trusted ───────────────────────────────────────
check('a store-method archive round-trips', () => {
  const target = path.join(root, 'stored');
  const written = extractZip(buildStoredZip([{ name: 'a/b.txt', data: 'stored payload' }]), target);
  assert.equal(written, 1);
  assert.equal(fs.readFileSync(path.join(target, 'a', 'b.txt'), 'utf8'), 'stored payload');
});
check('a traversal entry is refused', () => {
  const target = path.join(root, 'evil');
  fs.mkdirSync(target, { recursive: true });
  assert.equal(isUnsafeEntryName('../escape.txt'), true);
  assert.equal(isUnsafeEntryName('C:/windows/system32/x.dll'), true);
  assert.equal(isUnsafeEntryName('/etc/passwd'), true);
  assert.equal(isUnsafeEntryName('lib/index.js'), false);
  assert.throws(() => extractZip(buildStoredZip([{ name: '../../escape.txt', data: 'pwned' }]), target), /unsafe path/u);
  assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
});
check('a corrupted entry is reported', () => {
  const buffer = buildStoredZip([{ name: 'a.txt', data: 'payload' }]);
  // Entry data begins after the 30-byte local header and the name; flipping it
  // must be caught by the CRC the central directory records.
  buffer.writeUInt8(buffer.readUInt8(35) ^ 0xff, 35);
  assert.throws(() => extractZip(buffer, path.join(root, 'corrupt')), /CRC mismatch/u);
});
check('a non-archive is reported clearly', () => {
  assert.throws(() => extractZip(Buffer.from('this is not a zip file at all'), path.join(root, 'nope')), /not a ZIP archive/u);
});

// ── helpers ─────────────────────────────────────────────────────────────────
check('skipping covers packaging noise at any depth', () => {
  assert.equal(shouldSkip('a/node_modules/x.js'), true);
  assert.equal(shouldSkip('.git/config'), true);
  assert.equal(shouldSkip('a/b/.DS_Store'), true);
  assert.equal(shouldSkip('src/index.js'), false);
});
check('the package root is found under a wrapper directory', () => {
  const wrapper = path.join(root, 'wrapper', 'inner');
  fs.mkdirSync(wrapper, { recursive: true });
  fs.writeFileSync(path.join(wrapper, 'package.json'), '{"name":"x"}');
  assert.equal(resolvePluginRoot(path.join(root, 'wrapper')), wrapper);
});
check('inspection reports a broken manifest', () => {
  const broken = path.join(root, 'broken');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'package.json'), '{ not json');
  assert.equal(inspectPluginDir(broken).ok, false);
  assert.match(inspectPluginDir(broken).problem, /not valid JSON/u);
});
check('dropped file names that escape the destination are refused', () => {
  assert.throws(() => writeDroppedFiles([{ path: '../evil.js', data: '' }], path.join(root, 'escape-dest')), /escapes the staging directory/u);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
