/**
 * End-to-end checks for the host half, driven through its real HTTP handler
 * with a temporary DSH home and a stub `plugin-cli.js`.
 *
 * Nothing here touches a real profile: the stub records the argv it was given,
 * which is how these checks prove the drop produced the exact operation
 * (`<profile> add <absolute path>`) that `dsh plugin add` performs.
 *
 * Run with: node test/host.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-drop-host-'));
const home = path.join(root, 'home');
const profileDirectory = path.join(home, 'profiles', 'desktop');
const appRoot = path.join(home, 'profiles', 'node_modules', 'dsh-desktop-next');
const invoked = path.join(root, 'invoked.txt');

// A home that satisfies every path the host half resolves.
fs.mkdirSync(profileDirectory, { recursive: true });
fs.mkdirSync(path.join(appRoot, 'lib'), { recursive: true });
fs.writeFileSync(path.join(profileDirectory, 'package.json'), JSON.stringify({
  name: 'dsh-profile-desktop',
  dependencies: { 'existing-plugin': 'link:C:/tmp/existing-plugin' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'existing-plugin'] } },
}, null, 2));
fs.writeFileSync(path.join(appRoot, 'lib', 'plugin-cli.js'), [
  "import fs from 'node:fs'",
  `fs.appendFileSync(${JSON.stringify(invoked)}, JSON.stringify({ argv: process.argv.slice(2), home: process.env.DSH_HOME, cwd: process.cwd() }) + '\\n')`,
  "process.stdout.write('stub operation output\\n')",
  'process.exitCode = 0',
  '',
].join('\n'));

process.env.DSH_HOME = home;
process.env.DSH_PROFILE = 'desktop';
process.env.DSH_PROFILE_DIR = profileDirectory;

const { apply } = await import('../index.js');

let passed = 0;
const check = async (label, run) => {
  await run();
  passed += 1;
  console.log(`  ok  ${label}`);
};

/** Capture the routes the plugin registers, without a real web server. */
/** Mount the plugin on a fake context and hand back the routes it registered. */
function mount(extra = {}) {
  const routes = [];
  const base = {
    logger: { info() {}, warn() {} },
    effect: callback => { const disposer = callback(); return () => { if (typeof disposer === 'function') disposer(); }; },
    ...extra,
  };
  const scoped = { ...base, webServer: { register: route => { routes.push(route); return () => {}; } } };
  base.inject = (services, callback) => { callback(scoped); return () => {}; };
  apply(base);
  return routes;
}

const registered = mount();
const handler = registered[0]?.handler;
assert.equal(registered[0]?.path, '/api/plugin-drop', 'the installer mounts its own prefix');

/** A minimal request: the handler reads the body as a stream, as node:http delivers it. */
function request({ method, url, headers = {}, body, remoteAddress = '127.0.0.1' }) {
  const listeners = new Map();
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress },
    on(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); return req; },
    destroy() {},
  };
  if (body !== undefined) {
    setTimeout(() => {
      for (const listener of listeners.get('data') ?? []) listener(Buffer.from(body));
      for (const listener of listeners.get('end') ?? []) listener();
    }, 0);
  }
  return req;
}

/** A minimal response, capturing what the handler wrote. */
function response() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body ?? ''; },
  };
}

const call = async (options, target = handler) => {
  const res = response();
  await target(request(options), res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, body: res.body, json };
};

const jsonPost = (url, payload, extraHeaders = {}) => call({
  method: 'POST',
  url,
  headers: { 'content-type': 'application/json', 'x-plugin-drop': '1', ...extraHeaders },
  body: JSON.stringify(payload),
});

const settle = async jobId => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await call({ method: 'GET', url: `/api/plugin-drop/job?id=${jobId}` });
    if (result.json.state !== 'running') return result.json;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('the operation never settled');
};

console.log('plugin-drop host tests');

await check('the installer page is served from its own route', async () => {
  const result = await call({ method: 'GET', url: '/api/plugin-drop/' });
  assert.equal(result.status, 200);
  assert.match(result.headers['content-type'], /text\/html/u);
  assert.match(result.body, /插件拖放安装器/u);
});

await check('state names the profile, its dependencies, and the staging root', async () => {
  const result = await call({ method: 'GET', url: '/api/plugin-drop/state' });
  assert.equal(result.status, 200);
  assert.equal(result.json.available, true);
  assert.equal(result.json.profile, 'desktop');
  assert.equal(result.json.profileDirectory, profileDirectory);
  assert.equal(result.json.stagingRoot, path.join(home, 'plugin-drop', 'staged'));
  assert.deepEqual(result.json.dependencies.map(row => row.name), ['existing-plugin']);
  assert.equal(result.json.dependencies[0].isBundle, true);
});

await check('a dropped folder is staged and installed through the official operation', async () => {
  const payload = {
    files: [
      { path: 'my-plugin/package.json', data: Buffer.from(JSON.stringify({ name: 'my-dropped-plugin', version: '2.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })).toString('base64') },
      { path: 'my-plugin/cordis.patch.yml', data: Buffer.from('- insert: []\n').toString('base64') },
      { path: 'my-plugin/node_modules/junk/index.js', data: Buffer.from('ignored').toString('base64') },
    ],
  };
  const staged = await jsonPost('/api/plugin-drop/stage', payload);
  assert.equal(staged.status, 200, staged.body);
  assert.equal(staged.json.inspection.name, 'my-dropped-plugin');
  assert.equal(staged.json.inspection.hasBundlePatch, true);
  assert.equal(fs.existsSync(path.join(staged.json.installPath, 'package.json')), true);
  assert.equal(fs.existsSync(path.join(staged.json.installPath, 'node_modules')), false);

  const started = await jsonPost('/api/plugin-drop/install', { token: staged.json.token });
  assert.equal(started.status, 200, started.body);
  assert.equal(started.json.spec, staged.json.installPath);
  const job = await settle(started.json.jobId);
  assert.equal(job.state, 'done');
  assert.equal(job.exitCode, 0);
  assert.match(job.output, /stub operation output/u);

  // The stub proves what the real CLI would have been asked to do.
  const records = fs.readFileSync(invoked, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const last = records.at(-1);
  assert.deepEqual(last.argv, ['desktop', 'add', staged.json.installPath]);
  assert.equal(last.home, home);
});

await check('a .zip drop is unpacked and installed the same way', async () => {
  const { execFileSync } = await import('node:child_process');
  const source = path.join(root, 'zip-source', 'wrapped');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'zipped-plugin', version: '0.3.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  fs.writeFileSync(path.join(source, 'cordis.patch.yml'), '- insert: []\n');
  const archive = path.join(root, 'zipped-plugin.zip');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${source}' -DestinationPath '${archive}' -Force`], { stdio: 'pipe' });

  const staged = await jsonPost('/api/plugin-drop/stage', { files: [{ path: 'zipped-plugin.zip', data: fs.readFileSync(archive).toString('base64') }] });
  assert.equal(staged.status, 200);
  assert.equal(staged.json.inspection.name, 'zipped-plugin');
  const started = await jsonPost('/api/plugin-drop/install', { token: staged.json.token });
  const job = await settle(started.json.jobId);
  assert.equal(job.state, 'done');
});

await check('an absolute path installs without uploading', async () => {
  const plugin = path.join(root, 'local-plugin');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'local-plugin' }));
  const started = await jsonPost('/api/plugin-drop/install', { spec: plugin });
  assert.equal(started.status, 200);
  assert.equal(started.json.spec, plugin);
  const job = await settle(started.json.jobId);
  assert.equal(job.state, 'done');
});

await check('a package spec is passed to pnpm unchanged', async () => {
  const started = await jsonPost('/api/plugin-drop/install', { spec: 'some-plugin@1.2.3' });
  assert.equal(started.status, 200);
  assert.equal(started.json.spec, 'some-plugin@1.2.3');
  await settle(started.json.jobId);
  const records = fs.readFileSync(invoked, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.at(-1).argv, ['desktop', 'add', 'some-plugin@1.2.3']);
});

await check('remove is the mirror operation', async () => {
  const started = await jsonPost('/api/plugin-drop/remove', { name: 'existing-plugin' });
  assert.equal(started.status, 200);
  await settle(started.json.jobId);
  const records = fs.readFileSync(invoked, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.at(-1).argv, ['desktop', 'remove', 'existing-plugin']);
});

// ── refusals ────────────────────────────────────────────────────────────────
await check('a mutation without the page header is refused', async () => {
  const result = await call({ method: 'POST', url: '/api/plugin-drop/install', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(result.status, 403);
});

await check('a request from another machine is refused', async () => {
  const result = await call({ method: 'GET', url: '/api/plugin-drop/', remoteAddress: '192.168.2.4' });
  assert.equal(result.status, 403);
  const state = await call({ method: 'GET', url: '/api/plugin-drop/state', remoteAddress: '::ffff:192.168.2.4' });
  assert.equal(state.status, 403);
});

await check('a non-JSON content type is refused', async () => {
  const result = await call({ method: 'POST', url: '/api/plugin-drop/install', headers: { 'content-type': 'text/plain', 'x-plugin-drop': '1' }, body: '{}' });
  assert.equal(result.status, 415);
});

await check('content that is not a plugin is refused before anything is installed', async () => {
  const before = fs.existsSync(invoked) ? fs.readFileSync(invoked, 'utf8').length : 0;
  const result = await jsonPost('/api/plugin-drop/stage', { files: [{ path: 'notes/readme.txt', data: Buffer.from('hello').toString('base64') }] });
  assert.equal(result.status, 400);
  assert.match(result.json.error, /no package\.json/u);
  assert.equal(fs.readFileSync(invoked, 'utf8').length, before, 'no operation may be started');
});

await check('a staged package is listed from disk, not from memory', async () => {
  const payload = {
    files: [
      { path: 'listed/package.json', data: Buffer.from(JSON.stringify({ name: 'listed-plugin', version: '3.1.4', dsh: { bundle: { patch: './cordis.patch.yml' } } })).toString('base64') },
      { path: 'listed/cordis.patch.yml', data: Buffer.from('- insert: []\n').toString('base64') },
    ],
  };
  const staged = await jsonPost('/api/plugin-drop/stage', payload);
  assert.equal(staged.status, 200, staged.body);
  const state = await call({ method: 'GET', url: '/api/plugin-drop/state' });
  const listed = (state.json.staged ?? []).find(entry => entry.name === 'listed-plugin');
  assert.ok(listed !== undefined, 'the staged package is listed');
  assert.equal(listed.version, '3.1.4');
  assert.equal(listed.hasBundlePatch, true);
  assert.equal(listed.installPath, staged.json.installPath);
  assert.match(state.json.logPath, /plugin-drop\.log$/u);
});

await check('the staged list is installable by path, without any token', async () => {
  const state = await call({ method: 'GET', url: '/api/plugin-drop/state' });
  const listed = (state.json.staged ?? []).find(entry => entry.name === 'listed-plugin');
  const started = await jsonPost('/api/plugin-drop/install', { spec: listed.installPath });
  assert.equal(started.status, 200, started.body);
  const job = await settle(started.json.jobId);
  assert.equal(job.state, 'done');
  const records = fs.readFileSync(invoked, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.at(-1).argv, ['desktop', 'add', listed.installPath]);
});

await check('a staged package can be deleted, and only from the staging root', async () => {
  const state = await call({ method: 'GET', url: '/api/plugin-drop/state' });
  const listed = (state.json.staged ?? []).find(entry => entry.name === 'listed-plugin');
  const outside = await jsonPost('/api/plugin-drop/staged/delete', { path: path.join(root, 'not-staged') });
  assert.equal(outside.status, 400, 'a path outside the staging root is refused');
  const removed = await jsonPost('/api/plugin-drop/staged/delete', { path: listed.directory });
  assert.equal(removed.status, 200, removed.body);
  assert.equal(fs.existsSync(listed.directory), false);
  const after = await call({ method: 'GET', url: '/api/plugin-drop/state' });
  assert.equal((after.json.staged ?? []).some(entry => entry.name === 'listed-plugin'), false);
});

await check('an unknown staged token is refused', async () => {
  const result = await jsonPost('/api/plugin-drop/install', { token: 'stage-nope' });
  assert.equal(result.status, 409);
});

await check('an absolute path with no package is refused', async () => {
  const empty = path.join(root, 'not-a-plugin');
  fs.mkdirSync(empty, { recursive: true });
  const result = await jsonPost('/api/plugin-drop/install', { spec: empty });
  assert.equal(result.status, 400);
  assert.match(result.json.error, /not a plugin package/u);
});

await check('an empty install request is refused', async () => {
  const result = await jsonPost('/api/plugin-drop/install', {});
  assert.equal(result.status, 400);
});

await check('an unknown route reports itself', async () => {
  const result = await call({ method: 'GET', url: '/api/plugin-drop/nope' });
  assert.equal(result.status, 404);
});

await check('the published profile context is authoritative over the environment', async () => {
  // The desktop host publishes profileContext; the environment here disagrees
  // with it, and the published value must win.
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  const routes = mount({
    get: name => (name === 'profileContext'
      ? { name: 'from-service', dir: elsewhere, home, installAnchor: path.join(appRoot, 'package.json') }
      : undefined),
  });
  const target = routes[0].handler;
  const state = await call({ method: 'GET', url: '/api/plugin-drop/state' }, target);
  assert.equal(state.status, 200);
  assert.equal(state.json.available, true);
  assert.equal(state.json.profile, 'from-service');
  assert.equal(state.json.profileDirectory, elsewhere);

  // An install through that context still names the same profile and home.
  const plugin = path.join(root, 'service-plugin');
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'service-plugin' }));
  const started = await call({
    method: 'POST',
    url: '/api/plugin-drop/install',
    headers: { 'content-type': 'application/json', 'x-plugin-drop': '1' },
    body: JSON.stringify({ spec: plugin }),
  }, target);
  assert.equal(started.status, 200, started.body);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await call({ method: 'GET', url: `/api/plugin-drop/job?id=${started.json.jobId}` }, target);
    if (job.json.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const records = fs.readFileSync(invoked, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.at(-1).argv, ['from-service', 'add', plugin]);
});

await check('every stage, install, removal and refusal is written to the log file', async () => {
  const state = await call({ method: 'GET', url: '/api/plugin-drop/state' });
  const log = fs.readFileSync(state.json.logPath, 'utf8');
  assert.match(log, /resolved profile desktop/u);
  assert.match(log, /staged my-dropped-plugin/u);
  assert.match(log, /install started: /u);
  assert.match(log, /install refused: /u, 'a refused install is recorded with its reason');
  assert.match(log, /removed staged copy /u);
  assert.match(log, /→ done \(exit 0\)/u, 'an operation outcome is recorded');
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
