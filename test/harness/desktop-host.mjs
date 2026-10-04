/**
 * Boot the desktop Host composition the way the Electron shell boots it —
 * same entry, same arguments, and the IPC channel `lib/host.js` requires.
 *
 * This exists so a scratch profile can be exercised through the real production
 * composition (NextWebServer, the desktop plugin adapter, the client boot graph)
 * without starting the GUI or touching the profile the application is using.
 *
 * Usage: node test/harness/desktop-host.mjs <scratchHome> <profileDirectory> [port]
 *
 * The application is located through `DSH_APP_DIR` (default: the usual install
 * locations) and `DSH_EXECUTABLE` (default: the executable beside that install).
 *
 * With no `DSH_NEXT_NATIVE_TOKEN` the host installs no browser-access policy, so
 * every request is permitted — which is what lets an HTTP client drive the
 * installer in this harness. The real application sets the token and admits only
 * its own renderer.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The installed DSH application directory: `DSH_APP_DIR`, else the usual places. */
function resolveAppDirectory() {
  const candidates = [
    process.env.DSH_APP_DIR,
    process.env.LOCALAPPDATA === undefined ? null : path.join(process.env.LOCALAPPDATA, 'Programs', 'DSH NEXT', 'resources', 'app'),
    process.env.ProgramFiles === undefined ? null : path.join(process.env.ProgramFiles, 'DSH NEXT', 'resources', 'app'),
    '/Applications/DSH NEXT.app/Contents/Resources/app',
    '/opt/DSH NEXT/resources/app',
  ].filter(candidate => typeof candidate === 'string' && candidate !== '');
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'lib', 'host.js'))) return candidate;
  }
  throw new Error(`could not find the DSH application directory (looked for lib/host.js under ${candidates.join(', ')}); set DSH_APP_DIR to <install>/resources/app`);
}

const APP = resolveAppDirectory();
// `<install>/resources/app` → `<install>/DSH NEXT.exe`
const EXECUTABLE = process.env.DSH_EXECUTABLE ?? path.resolve(APP, '..', '..', 'DSH NEXT.exe');

const [home, profileDirectory, port] = process.argv.slice(2);
if (home === undefined || profileDirectory === undefined) {
  console.error('usage: desktop-host.mjs <scratchHome> <profileDirectory> [port]');
  process.exit(2);
}

const child = spawn(EXECUTABLE, ['--expose-internals', path.join(APP, 'lib', 'host.js'), APP, profileDirectory], {
  env: {
    ...process.env,
    DSH_HOME: home,
    ...(process.versions.electron === undefined ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    DSH_NEXT_PREFERENCES: JSON.stringify({
      browserAccess: false,
      port: Number(port ?? 0),
      logLevel: 'info',
    }),
    DSH_NEXT_TRUSTED_HOSTS: '[]',
  },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});

child.stdout.on('data', chunk => process.stdout.write(`[host] ${chunk}`));
child.stderr.on('data', chunk => process.stderr.write(`[host] ${chunk}`));
child.on('message', message => {
  console.log(`[ipc] ${JSON.stringify(message)}`);
  if (message !== null && typeof message === 'object' && message.type === 'ready') console.log(`READY_URL=${message.url}`);
});
child.on('error', cause => {
  console.error(`[harness] could not start the host: ${cause.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  console.log(`[host] exited code=${code} signal=${signal}`);
  process.exitCode = code ?? 0;
});

const stop = () => {
  if (child.connected) child.send({ type: 'shutdown' });
  setTimeout(() => child.kill('SIGTERM'), 5000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
