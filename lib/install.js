/**
 * Running the official profile operation.
 *
 * Installing a plugin is not this tool's own logic: DSH ships one operation
 * behind `dsh plugin add` that writes the profile dependency, links it, and
 * reconciles `dsh.profile.bundles`. Everything here exists to hand that
 * operation a correctly staged package and to show its output as it arrives,
 * so a drop produces byte-for-byte the same profile state as the CLI command.
 *
 * A profile-installed plugin cannot rely on bare `@deepseek-ai/*` imports
 * (nothing puts them on its resolution path), so this module resolves
 * everything through `node:` builtins, `process.argv`, and the file system.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Where the bundled pnpm and the plugin CLI live. */
const CLI_RELATIVE = ['lib', 'plugin-cli.js'];
/** Output kept per job, so a long pnpm run cannot grow without bound. */
const MAX_JOB_OUTPUT_BYTES = 262_144;
/** Finished jobs kept for the page to consult. */
const MAX_JOBS = 24;

/** An install that could not even be started. */
export class InstallError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'InstallError';
    this.status = status;
  }
}

/** The first candidate whose `lib/plugin-cli.js` really exists. */
function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    if (fs.existsSync(path.join(candidate, ...CLI_RELATIVE))) return candidate;
  }
  return null;
}

/**
 * Locate the application root, which owns `lib/plugin-cli.js` and the bundled pnpm.
 *
 * The host process is started as `<electron> --expose-internals <app>/lib/host.js
 * <app> <profileDir>`, so its own argv names the root; the profile's
 * `node_modules/dsh-desktop-next` junction and Electron's `resourcesPath` cover
 * the cases where it does not. `extra` carries the profile context's install
 * anchor, which names the package the profile installs against.
 *
 * @returns the root, or null when this composition keeps the adapter elsewhere.
 */
export function resolveAppRoot(home, extra = []) {
  const candidates = extra.filter(candidate => typeof candidate === 'string' && candidate !== '');
  const fromArgv = process.argv.slice(1).find(argument => typeof argument === 'string' && fs.existsSync(path.join(argument, ...CLI_RELATIVE)));
  const fromJunction = (() => {
    if (home === null) return null;
    try {
      return fs.realpathSync(path.join(home, 'profiles', 'node_modules', 'dsh-desktop-next'));
    } catch {
      return null;
    }
  })();
  const fromResources = process.resourcesPath === undefined ? null : path.join(process.resourcesPath, 'app');
  const fromExecutable = path.join(path.dirname(process.execPath), 'resources', 'app');
  return firstExisting([...candidates, fromArgv, fromResources, fromExecutable, fromJunction]);
}

/** A non-empty string, or null. */
function stringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Installation roots named by the profile's install anchor.
 *
 * The desktop application installs against its own manifest (`<app>/package.json`),
 * while an upstream boot installs against the `dsh` package inside a
 * `node_modules` tree (`<app>/node_modules/@deepseek-ai/dsh/package.json`), whose
 * application root is three levels up. Both are offered so the adapter and the
 * bundled pnpm are found in either composition.
 */
function anchorRoots(installAnchor) {
  if (installAnchor === null) return [];
  const directory = path.dirname(installAnchor);
  return [directory, path.resolve(directory, '..', '..', '..')];
}

/**
 * The context the host publishes for the running profile.
 *
 * `profileContext` is authoritative — it is the same object the shipped plugin
 * manager installs against — so it is preferred over anything guessed from the
 * environment. It may be absent in a composition that does not mount it.
 *
 * @param profileContext The `profileContext` service, when the context has one.
 * @returns the install context, or null when the service lacks what is needed.
 */
export function contextFromProfileContext(profileContext) {
  if (profileContext === undefined || profileContext === null) return null;
  const profile = stringOrNull(profileContext.name);
  const profileDirectory = stringOrNull(profileContext.dir);
  if (profile === null || profileDirectory === null) return null;
  const installAnchor = stringOrNull(profileContext.installAnchor);
  const home = stringOrNull(profileContext.home);
  return {
    home,
    profile,
    profileDirectory,
    installAnchor,
    appRoot: resolveAppRoot(home, anchorRoots(installAnchor)),
    source: 'profileContext',
  };
}

/**
 * Work out which home, profile, and directory this tool is acting on.
 *
 * The environment is authoritative (the host sets `DSH_HOME`, `DSH_PROFILE`,
 * and `DSH_PROFILE_DIR`); the host's own argv and the known layout fill in the
 * rest, so a tool loaded in a profile still installs into that same profile.
 */
export function resolveInstallContext() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : (() => {
      const fromArgv = process.argv.slice(1).find(argument => typeof argument === 'string' && /[\\/]profiles[\\/][^\\/]+$/u.test(argument));
      return fromArgv === undefined ? null : path.dirname(path.dirname(fromArgv));
    })();
  const profileDirectory = typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== ''
    ? process.env.DSH_PROFILE_DIR
    : process.argv.slice(1).find(argument => typeof argument === 'string' && /[\\/]profiles[\\/][^\\/]+$/u.test(argument)) ?? null;
  const profile = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== ''
    ? process.env.DSH_PROFILE
    : (profileDirectory === null ? null : path.basename(profileDirectory));
  if (profile === null || profileDirectory === null) throw new InstallError('this tool could not work out which profile it is running in');
  return { home, profile, profileDirectory, installAnchor: null, appRoot: resolveAppRoot(home), source: 'environment' };
}

/**
 * The install context for this plugin: what the host publishes, else what the
 * environment and the host's own argv say. An application root that cannot be
 * found is not fatal here — only running an operation needs one.
 * @param profileContext The `profileContext` service when the composition mounts it.
 */
export function resolveContext(profileContext) {
  const published = (() => {
    try {
      return contextFromProfileContext(profileContext);
    } catch {
      return null;
    }
  })();
  if (published !== null) return published;
  return resolveInstallContext();
}

/** Where this tool stages drops and keeps the small tools it generates. */
export function stagingRootFor(home) {
  return path.join(home ?? process.env.DSH_HOME ?? '.', 'plugin-drop', 'staged');
}

/** The directory holding generated helpers, next to the staging root. */
export function toolsRootFor(home) {
  return path.join(home ?? process.env.DSH_HOME ?? '.', 'plugin-drop', 'tools');
}

/**
 * A `pnpm` shim that runs the pnpm the application bundles.
 *
 * The upstream CLI expects `pnpm` on PATH; the desktop adapter does not, because
 * it spawns the bundled copy directly. Writing a shim keeps a CLI-booted profile
 * working without asking the person to install pnpm system-wide.
 *
 * @returns the directory to put first on PATH, or null when nothing is bundled.
 */
function ensurePnpmShim(context) {
  if (context.home === null) return null;
  const roots = [context.appRoot, ...anchorRoots(context.installAnchor)].filter(root => root !== null);
  const entry = roots
    .map(root => path.join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
    .find(candidate => fs.existsSync(candidate));
  if (entry === undefined) return null;
  const directory = toolsRootFor(context.home);
  try {
    fs.mkdirSync(directory, { recursive: true });
    const prefix = process.versions.electron === undefined ? '' : 'set "ELECTRON_RUN_AS_NODE=1"\r\n';
    const windows = `@echo off\r\n${prefix}"${process.execPath}" "${entry}" %*\r\n`;
    const posix = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${entry}" "$@"\n`;
    const windowsPath = path.join(directory, 'pnpm.cmd');
    const posixPath = path.join(directory, 'pnpm');
    if (!fs.existsSync(windowsPath)) fs.writeFileSync(windowsPath, windows);
    if (!fs.existsSync(posixPath)) {
      fs.writeFileSync(posixPath, posix);
      fs.chmodSync(posixPath, 0o755);
    }
    return directory;
  } catch {
    return null;
  }
}

/**
 * How to run the official profile operation in this composition.
 *
 * Two adapters exist and both perform the same operation:
 *   1. the Next/desktop adapter, `<app>/lib/plugin-cli.js`, which is what the
 *      desktop application itself runs for plugin management — it uses the
 *      bundled pnpm, so it needs nothing on PATH;
 *   2. the upstream CLI, `<dsh package>/lib/bin.js plugin --profile <name>`,
 *      for a profile booted by `dsh` — which refuses its reserved `desktop`
 *      profile, so it is never used for one.
 */
export function planLaunch(context) {
  const cli = context.appRoot === null ? null : path.join(context.appRoot, ...CLI_RELATIVE);
  if (cli !== null && fs.existsSync(cli)) {
    return {
      kind: 'plugin-cli',
      command: process.execPath,
      argvPrefix: ['--expose-internals', cli, context.profile],
      env: {},
    };
  }
  const anchorDirectory = context.installAnchor === null ? null : path.dirname(context.installAnchor);
  const candidates = [
    anchorDirectory === null ? null : path.join(anchorDirectory, 'lib', 'bin.js'),
    context.appRoot === null ? null : path.join(context.appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ].filter(candidate => candidate !== null && fs.existsSync(candidate));
  if (context.profile !== 'desktop' && candidates.length > 0) {
    const shim = ensurePnpmShim(context);
    return {
      kind: 'dsh-cli',
      command: process.execPath,
      argvPrefix: [candidates[0], 'plugin', '--profile', context.profile],
      env: shim === null ? {} : { PATH: `${shim}${path.delimiter}${process.env.PATH ?? ''}` },
    };
  }
  throw new InstallError(`could not find the DSH plugin adapter for profile ${context.profile}; expected ${cli ?? 'lib/plugin-cli.js'} to exist`);
}

/** Read the profile manifest: what this profile depends on and which bundles it loads. */
export function readProfileSummary(context) {
  const manifestPath = path.join(context.profileDirectory, 'package.json');
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = {};
  }
  const dependencies = manifest.dependencies ?? {};
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  return {
    home: context.home,
    profile: context.profile,
    profileDirectory: context.profileDirectory,
    appRoot: context.appRoot ?? 'not located in this composition',
    contextSource: context.source,
    stagingRoot: stagingRootFor(context.home),
    manifestPath,
    bundles,
    dependencies: Object.entries(dependencies).map(([name, spec]) => ({ name, spec: String(spec), isBundle: bundles.includes(name) })),
  };
}

/** A bounded log of one background operation, as the page polls it. */
export function createJobStore() {
  const jobs = new Map();
  const append = (job, text) => {
    job.output += text;
    if (job.output.length > MAX_JOB_OUTPUT_BYTES) job.output = `…\n${job.output.slice(job.output.length - MAX_JOB_OUTPUT_BYTES)}`;
  };
  return {
    create(kind, title) {
      const job = { id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, kind, title, state: 'running', exitCode: null, output: '', startedAt: new Date().toISOString(), finishedAt: null };
      jobs.set(job.id, job);
      const finished = [...jobs.values()].filter(candidate => candidate.state !== 'running');
      for (const stale of finished.slice(0, Math.max(0, finished.length - MAX_JOBS))) jobs.delete(stale.id);
      return job;
    },
    append(job, text) {
      append(job, text);
    },
    finish(job, state, exitCode) {
      job.state = state;
      job.exitCode = exitCode;
      job.finishedAt = new Date().toISOString();
    },
    get(id) {
      const job = jobs.get(id);
      return job === undefined ? null : { id: job.id, kind: job.kind, title: job.title, state: job.state, exitCode: job.exitCode, output: job.output, startedAt: job.startedAt, finishedAt: job.finishedAt };
    },
    list() {
      return [...jobs.values()].map(job => ({ id: job.id, kind: job.kind, title: job.title, state: job.state, exitCode: job.exitCode, startedAt: job.startedAt, finishedAt: job.finishedAt }));
    },
  };
}

/** One line of the operation to show as a title. */
function describeOperation(args) {
  const [command, ...rest] = args;
  const verb = command === 'add' || command === 'install' || command === 'i' ? 'install' : command === 'remove' || command === 'rm' ? 'remove' : String(command);
  return `${verb} ${rest.filter(argument => !argument.startsWith('-')).join(' ') || ''}`.trim();
}

/**
 * Start the official plugin operation and stream it into a job.
 *
 * @param options the resolved context, the job store, the operation arguments, and the working directory the operation runs from.
 * @returns the started job.
 */
export function startPluginOperation(options) {
  const { context, jobs, args, cwd } = options;
  if (!Array.isArray(args) || args.length === 0) throw new InstallError('no plugin operation was requested', 400);
  if (!args.every(argument => typeof argument === 'string' && argument !== '')) throw new InstallError('the plugin operation was built with an empty argument', 400);
  const plan = planLaunch(context);
  const job = jobs.create('plugin', describeOperation(args));
  const child = spawn(plan.command, [...plan.argvPrefix, ...args], {
    cwd: cwd ?? context.profileDirectory,
    windowsHide: true,
    env: {
      ...process.env,
      ...plan.env,
      ...(context.home === null ? {} : { DSH_HOME: context.home }),
      DSH_PROFILE: context.profile,
      DSH_PROFILE_DIR: context.profileDirectory,
      ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  jobs.append(job, `$ ${[plan.kind, ...args].join(' ')}\n`);
  const forward = stream => chunk => { jobs.append(job, chunk.toString('utf8')); options.onOutput?.(chunk.toString('utf8'), stream); };
  child.stdout.on('data', forward('stdout'));
  child.stderr.on('data', forward('stderr'));
  child.on('error', cause => {
    jobs.append(job, `\nfailed to start the plugin operation: ${cause.message}\n`);
    jobs.finish(job, 'failed', null);
  });
  child.on('close', exitCode => {
    jobs.finish(job, exitCode === 0 ? 'done' : 'failed', exitCode);
    options.onFinished?.(job);
  });
  return job;
}
