/**
 * Live acceptance test: drive a running installer exactly as the page does.
 *
 * It walks a real plugin package, posts it the way a browser drop would, and
 * checks that the profile ends up with the dependency, the junction, and the
 * bundle entry — the same end state `dsh plugin add <path>` produces.
 *
 * Usage: node test/live.test.mjs <baseUrl> <pluginDirectory>
 *   baseUrl         an installer that is already running, e.g. http://127.0.0.1:34601
 *   pluginDirectory any real DSH plugin package to drop (its own directory)
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [baseArgument, directoryArgument] = process.argv.slice(2);
if (baseArgument === undefined || directoryArgument === undefined) {
  console.error('usage: node test/live.test.mjs <baseUrl> <pluginDirectory>');
  process.exit(2);
}
const base = baseArgument.replace(/\/+$/u, '');
const pluginDirectory = path.resolve(directoryArgument);
if (!fs.existsSync(path.join(pluginDirectory, 'package.json'))) {
  console.error(`not a plugin package (no package.json): ${pluginDirectory}`);
  process.exit(2);
}
const API = `${base}/api/plugin-drop`;
const SKIP = new Set(['node_modules', '.git', '__MACOSX', '.idea', '.vscode', '.cache']);

let passed = 0;
const check = async (label, run) => {
  await run();
  passed += 1;
  console.log(`  ok  ${label}`);
};

const json = async (response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`expected JSON, got: ${text.slice(0, 200)}`);
  }
};

const post = async (route, body, headers = {}) => {
  const response = await fetch(`${API}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-plugin-drop': '1', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: await json(response) };
};

/** Every file a browser would deliver for a dropped folder. */
function collect(directory, prefix = '', out = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) collect(absolute, `${relative}/`, out);
    else if (entry.isFile() && entry.name !== '.DS_Store') out.push({ path: relative, data: fs.readFileSync(absolute).toString('base64') });
  }
  return out;
}

const settle = async jobId => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const response = await fetch(`${API}/job?id=${encodeURIComponent(jobId)}`);
    const job = await json(response);
    if (job.state !== 'running') return job;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('the operation never settled');
};

console.log(`plugin-drop live acceptance test against ${base}`);

let state = null;
await check('the running host answers with its profile and staging root', async () => {
  const response = await fetch(`${API}/state`);
  assert.equal(response.status, 200);
  state = await json(response);
  assert.equal(state.available, true, `host reported: ${state.problem}`);
  assert.equal(state.profile, 'probe');
  assert.match(state.stagingRoot, /plugin-drop[\\/]staged$/u);
});

await check('the installer page is served to this client', async () => {
  const response = await fetch(`${API}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /插件拖放安装器/u);
  assert.match(html, /webkitGetAsEntry/u, 'the page walks dropped directories');
});

await check('a mutating request without the page header is refused', async () => {
  const response = await fetch(`${API}/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
});

let installed = null;
await check(`a real plugin package (${path.basename(pluginDirectory)}) installs from a drop`, async () => {
  const files = collect(pluginDirectory);
  assert.ok(files.length > 5, 'the package has content');
  const staged = await post('/stage', { files });
  assert.equal(staged.status, 200, JSON.stringify(staged.payload));
  installed = staged.payload.inspection.name;
  assert.equal(staged.payload.inspection.hasBundlePatch, true);
  assert.equal(staged.payload.inspection.hasClient, true, 'this package ships a browser half');
  assert.equal(fs.existsSync(path.join(staged.payload.installPath, 'package.json')), true);
  assert.equal(fs.existsSync(path.join(staged.payload.installPath, 'node_modules')), false, 'packaging noise is not staged');

  const started = await post('/install', { token: staged.payload.token });
  assert.equal(started.status, 200, JSON.stringify(started.payload));
  const job = await settle(started.payload.jobId);
  assert.equal(job.state, 'done', job.output);
  assert.equal(job.exitCode, 0);
});

await check('the profile now carries the dependency, its link and its bundle entry', async () => {
  const response = await fetch(`${API}/state`);
  const after = await json(response);
  const dependency = after.dependencies.find(row => row.name === installed);
  assert.ok(dependency !== undefined, `${installed} is a profile dependency`);
  assert.equal(dependency.isBundle, true, 'it was added to dsh.profile.bundles');
  assert.match(dependency.spec, /^link:/u);
  assert.equal(after.bundles.includes(installed), true);
  const manifest = JSON.parse(fs.readFileSync(after.manifestPath, 'utf8'));
  assert.equal(manifest.dsh.profile.bundles.includes(installed), true);
  assert.ok(fs.existsSync(path.join(after.profileDirectory, 'node_modules', installed, 'package.json')), 'the junction resolves');
});

await check('a .zip drop of the same package installs too', async () => {
  const parent = path.join(os.tmpdir(), `plugin-drop-live-${Date.now()}`);
  const wrapper = path.join(parent, 'wrapped-archive');
  fs.mkdirSync(wrapper, { recursive: true });
  // Filter against the path *below* the package: the package directory itself
  // lives under a node_modules directory.
  fs.cpSync(pluginDirectory, wrapper, {
    recursive: true,
    filter: source => !path.relative(pluginDirectory, source).split(path.sep).includes('node_modules'),
  });
  assert.equal(fs.existsSync(path.join(wrapper, 'package.json')), true, 'the copy holds the package');
  // Windows' bundled bsdtar writes a ZIP from a directory, unlike PowerShell's
  // Compress-Archive, which skips entries it cannot read.
  const archive = path.join(parent, 'out.zip');
  execFileSync('tar.exe', ['-a', '-c', '-f', archive, '-C', parent, 'wrapped-archive'], { stdio: 'pipe' });
  assert.equal(fs.readFileSync(archive).readUInt32LE(0), 0x04034b50, 'the archive is a ZIP');
  const staged = await post('/stage', { files: [{ path: 'package.zip', data: fs.readFileSync(archive).toString('base64') }] });
  assert.equal(staged.status, 200, JSON.stringify(staged.payload));
  assert.equal(staged.payload.inspection.name, installed);
  const started = await post('/install', { token: staged.payload.token });
  const job = await settle(started.payload.jobId);
  assert.equal(job.state, 'done', job.output);
  fs.rmSync(parent, { recursive: true, force: true });
});

await check('the installed plugin is removable again', async () => {
  const started = await post('/remove', { name: installed });
  assert.equal(started.status, 200, JSON.stringify(started.payload));
  const job = await settle(started.payload.jobId);
  assert.equal(job.state, 'done', job.output);
  const response = await fetch(`${API}/state`);
  const after = await json(response);
  assert.equal(after.dependencies.some(row => row.name === installed), false);
  assert.equal(after.bundles.includes(installed), false);
});

await check('a staged package survives without its token and installs by path', async () => {
  const files = collect(pluginDirectory);
  const staged = await post('/stage', { files });
  assert.equal(staged.status, 200, JSON.stringify(staged.payload));

  // Listing comes from disk, so a token lost to a restart does not matter.
  const state = await json(await fetch(`${API}/state`));
  const listed = (state.staged ?? []).find(entry => entry.name === installed);
  assert.ok(listed !== undefined, 'the staged package is listed from disk');
  assert.equal(listed.installPath, staged.payload.installPath);
  assert.match(state.logPath, /plugin-drop\.log$/u);

  const started = await post('/install', { spec: listed.installPath });
  assert.equal(started.status, 200, JSON.stringify(started.payload));
  const job = await settle(started.payload.jobId);
  assert.equal(job.state, 'done', job.output);

  const removal = await post('/remove', { name: installed });
  assert.equal((await settle(removal.payload.jobId)).state, 'done');
  const deleted = await post('/staged/delete', { path: listed.directory });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.payload));
  const after = await json(await fetch(`${API}/state`));
  assert.equal((after.staged ?? []).some(entry => entry.directory === listed.directory), false);
});

await check('the host recorded the whole session in its log file', async () => {
  const state = await json(await fetch(`${API}/state`));
  const log = fs.readFileSync(state.logPath, 'utf8');
  assert.match(log, /resolved profile /u);
  assert.match(log, /staged /u);
  assert.match(log, /install started: /u);
  assert.match(log, /→ done \(exit 0\)/u);
  assert.match(log, /removed staged copy /u);
});

console.log(`\n${passed} checks passed`);
