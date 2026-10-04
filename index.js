/**
 * Plugin Drop — the host half.
 *
 * Serves a small same-origin page that accepts a dropped plugin package and
 * installs it into the profile this plugin is running in. The install itself is
 * the official profile operation (`dsh plugin add <path>`): this half only
 * stages what was dropped, hands the operation an absolute path, and streams
 * the operation's own output back to the page.
 *
 * Routes are registered under `/api/plugin-drop` and fence themselves: they
 * execute code from a dropped package, so they answer only requests that come
 * from this machine, over a same-origin JSON POST.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  adoptStableDirectory, describeStagedPackages, inspectPluginDir, removeStagedPackage,
  resolvePluginRoot, StageError, stageDrop,
} from './lib/stage.js';
import {
  createJobStore, InstallError, readProfileSummary, resolveContext, startPluginOperation,
} from './lib/install.js';
import { createLogFile } from './lib/log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTE = '/api/plugin-drop';
/** A dropped payload is held in memory while it is staged; this bounds that. */
const MAX_UPLOAD_BYTES = 96 * 1024 * 1024;
/** Staged drops kept addressable until the page installs or forgets them. */
const MAX_STAGED = 8;

export const name = 'dsh-plugin-drop';

/** Loopback addresses a local browser can present. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Whether a request arrives from this machine. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return LOOPBACK.has(address);
}

/** Read a request body with a hard ceiling. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new InstallError(`the dropped payload is larger than the ${Math.round(limit / (1024 * 1024))} MiB limit`, 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', cause => reject(cause));
  });
}

/** A JSON body, or a 400 that names what was wrong. */
async function readJson(req) {
  const body = await readBody(req, MAX_UPLOAD_BYTES);
  if (body.length === 0) throw new InstallError('the request carried no body', 400);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new InstallError('the request body is not valid JSON', 400);
  }
}

/**
 * The host half.
 * @param ctx The cordis context of this profile row.
 */
export function apply(ctx) {
  const jobs = createJobStore();
  const stagedDrops = new Map();
  const logger = ctx.logger ?? console;

  // Every stage, install, removal and failure is also written here, because the
  // host's own logger is not reachable from a profile plugin and its output is
  // not visible in the desktop application's log file.
  let logFile = null;
  const log = () => {
    if (logFile !== null) return logFile;
    let home = null;
    try {
      home = currentContext().home;
    } catch {
      home = null;
    }
    logFile = createLogFile(home);
    return logFile;
  };

  // Resolved on first use rather than at apply time: `profileContext` is the
  // authoritative source and may be published after this row loads.
  let resolved = null;
  let resolvedProblem = null;
  const currentContext = () => {
    if (resolved !== null) return resolved;
    if (resolvedProblem !== null) throw new InstallError(resolvedProblem);
    try {
      resolved = resolveContext(typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined);
      logger?.info?.(`plugin-drop: acting on profile ${resolved.profile} (${resolved.profileDirectory}) via ${resolved.source}`);
      log().info(`resolved profile ${resolved.profile} at ${resolved.profileDirectory} via ${resolved.source}; app root ${String(resolved.appRoot)}`);
      return resolved;
    } catch (cause) {
      resolvedProblem = cause instanceof Error ? cause.message : String(cause);
      log().error(`could not resolve the profile context: ${resolvedProblem}`);
      throw new InstallError(resolvedProblem);
    }
  };

  const send = (res, status, payload) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': typeof payload === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  };

  /** Reject anything that is not a same-origin request from this machine. */
  const fence = req => {
    if (!isLoopback(req)) return { status: 403, payload: { error: 'this installer only answers requests from the machine DSH runs on' } };
    return null;
  };

  /** Reject a mutating request that did not come from the page (a cross-site form post cannot set this header). */
  const fenceMutation = req => {
    const fenced = fence(req);
    if (fenced !== null) return fenced;
    if (req.headers['x-plugin-drop'] !== '1') return { status: 403, payload: { error: 'this endpoint requires the installer page as its origin' } };
    const contentType = String(req.headers['content-type'] ?? '');
    if (!contentType.includes('application/json')) return { status: 415, payload: { error: 'this endpoint accepts JSON only' } };
    return null;
  };

  /**
   * What the host published and what the environment says, for the report the
   * page shows when the tool cannot work out which profile it is acting on.
   */
  const diagnosis = () => {
    const seen = {};
    try {
      const published = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
      seen.publishedContext = published === undefined || published === null
        ? 'absent'
        : `name=${String(published.name)} dir=${String(published.dir)} home=${String(published.home)} anchor=${String(published.installAnchor)}`;
    } catch (cause) {
      seen.publishedContext = `threw: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    seen.environment = `DSH_HOME=${process.env.DSH_HOME ?? 'unset'} DSH_PROFILE=${process.env.DSH_PROFILE ?? 'unset'} DSH_PROFILE_DIR=${process.env.DSH_PROFILE_DIR ?? 'unset'}`;
    seen.argv = process.argv.slice(1).join(' ');
    return seen;
  };

  /** Everything the page needs to describe the environment it is acting on. */
  const stateFor = () => {
    try {
      const context = currentContext();
      const stagingRoot = path.join(context.home ?? process.env.DSH_HOME ?? '.', 'plugin-drop', 'staged');
      return {
        available: true,
        ...readProfileSummary(context),
        // Staged packages come from disk, not from the in-memory token map, so
        // an install remains possible after a restart or a lost response.
        staged: describeStagedPackages(stagingRoot),
        logPath: log().path,
        jobs: jobs.list(),
      };
    } catch (cause) {
      return { available: false, problem: cause instanceof Error ? cause.message : String(cause), diagnosis: diagnosis() };
    }
  };

  /** Validate and remember a staged drop behind a short token. */
  const rememberStaged = staged => {
    const token = `stage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    stagedDrops.set(token, staged);
    for (const stale of [...stagedDrops.keys()].slice(0, Math.max(0, stagedDrops.size - MAX_STAGED))) stagedDrops.delete(stale);
    return token;
  };

  /**
   * What an install argument resolves to: a staged drop's path, a local path the
   * person typed, or a package spec handed to pnpm unchanged.
   */
  const resolveInstallSource = body => {
    if (typeof body.token === 'string' && body.token !== '') {
      const staged = stagedDrops.get(body.token);
      if (staged === undefined) throw new InstallError('that staged drop is no longer available; drop the package again', 409);
      return { path: staged.installPath, spec: staged.installPath, staged };
    }
    const raw = typeof body.spec === 'string' ? body.spec.trim() : '';
    if (raw === '') throw new InstallError('nothing to install: no staged drop and no path or spec was given', 400);
    const withoutProtocol = raw.replace(/^(?:file|link):/u, '');
    const looksLikePath = path.isAbsolute(withoutProtocol) || /^[a-zA-Z]:[\\/]/u.test(withoutProtocol);
    if (!looksLikePath) return { path: raw, spec: raw, staged: null };
    const resolved = path.resolve(withoutProtocol);
    if (!fs.existsSync(resolved)) throw new InstallError(`there is nothing at ${resolved}`, 400);
    const stat = fs.statSync(resolved);
    if (stat.isFile()) {
      const lower = resolved.toLowerCase();
      if (!lower.endsWith('.tgz') && !lower.endsWith('.tar.gz')) throw new InstallError('a local file must be a .tgz or .tar.gz package; drop a .zip on the page instead', 400);
      return { path: resolved, spec: resolved, staged: null };
    }
    const root = resolvePluginRoot(resolved);
    const inspection = inspectPluginDir(root);
    if (!inspection.ok) throw new InstallError(`${resolved} is not a plugin package: ${inspection.problem}`, 400);
    return { path: root, spec: root, staged: null, inspection };
  };

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname.slice(ROUTE.length).replace(/\/+$/u, '') || '/';
    const method = String(req.method ?? 'GET').toUpperCase();
    try {
      if (method === 'GET' && (route === '/' || route === '/index.html')) {
        const denied = fence(req);
        if (denied !== null) return send(res, denied.status, `<pre>${denied.payload.error}</pre>`);
        return send(res, 200, fs.readFileSync(path.join(here, 'page.html'), 'utf8'));
      }
      if (method === 'GET' && route === '/state') {
        const denied = fence(req);
        if (denied !== null) return send(res, denied.status, denied.payload);
        return send(res, 200, stateFor());
      }
      if (method === 'GET' && route === '/job') {
        const denied = fence(req);
        if (denied !== null) return send(res, denied.status, denied.payload);
        const job = jobs.get(url.searchParams.get('id') ?? '');
        if (job === null) return send(res, 404, { error: 'no such job' });
        return send(res, 200, job);
      }
      if (method === 'POST' && route === '/stage') {
        const denied = fenceMutation(req);
        if (denied !== null) return send(res, denied.status, denied.payload);
        const context = currentContext();
        const body = await readJson(req);
        try {
          const staged = stageDrop(body, path.join(context.home, 'plugin-drop', 'staged'));
          const settled = adoptStableDirectory(staged);
          const token = rememberStaged(settled);
          logger?.info?.(`plugin-drop: staged ${settled.inspection.name} at ${settled.installPath}`);
          log().info(`staged ${settled.inspection.name}${settled.inspection.version === null ? '' : `@${settled.inspection.version}`} (${settled.fileCount} files, ${settled.skipped} skipped) at ${settled.installPath}`);
          return send(res, 200, {
            token,
            kind: settled.kind,
            installPath: settled.installPath,
            fileCount: settled.fileCount,
            skipped: settled.skipped,
            inspection: settled.inspection,
          });
        } catch (cause) {
          log().error(`staging failed: ${cause instanceof Error ? cause.message : String(cause)}`);
          throw cause;
        }
      }
      if (method === 'POST' && route === '/install') {
        const denied = fenceMutation(req);
        if (denied !== null) return send(res, denied.status, denied.payload);
        const context = currentContext();
        const body = await readJson(req);
        let source;
        try {
          source = resolveInstallSource(body);
        } catch (cause) {
          log().warn(`install refused: ${cause instanceof Error ? cause.message : String(cause)} (request: ${JSON.stringify({ token: typeof body.token === 'string' ? `${body.token.slice(0, 12)}…` : undefined, spec: body.spec })}）`);
          throw cause;
        }
        // The spec is always absolute by now, so the operation runs from the
        // profile directory exactly as the shipped manager runs it.
        const job = startPluginOperation({
          context,
          jobs,
          args: ['add', source.spec],
          cwd: context.profileDirectory,
          onFinished: finished => log()[finished.state === 'done' ? 'info' : 'error'](`${finished.title} → ${finished.state} (exit ${String(finished.exitCode)})`),
        });
        logger?.info?.(`plugin-drop: ${job.title} (${context.profile})`);
        log().info(`install started: ${source.spec} (job ${job.id})`);
        return send(res, 200, { jobId: job.id, spec: source.spec, staged: source.staged === null ? null : { installPath: source.path, inspection: source.staged.inspection } });
      }
      if (method === 'POST' && route === '/staged/delete') {
        const denied = fenceMutation(req);
        if (denied !== null) return send(res, denied.status, denied.payload);
        const context = currentContext();
        const body = await readJson(req);
        const stagingRoot = path.join(context.home, 'plugin-drop', 'staged');
        const removed = removeStagedPackage(stagingRoot, body.path ?? body.spec ?? '');
        log().info(`removed staged copy ${removed}`);
        return send(res, 200, { removed });
      }
      if (method === 'POST' && route === '/remove') {
        const denied = fenceMutation(req);
        if (denied !== null) return send(res, denied.status, denied.payload);
        const context = currentContext();
        const body = await readJson(req);
        const target = typeof body.name === 'string' ? body.name.trim() : '';
        if (target === '') throw new InstallError('no plugin name was given', 400);
        const job = startPluginOperation({
          context,
          jobs,
          args: ['remove', target],
          cwd: context.profileDirectory,
          onFinished: finished => log()[finished.state === 'done' ? 'info' : 'error'](`${finished.title} → ${finished.state} (exit ${String(finished.exitCode)})`),
        });
        logger?.info?.(`plugin-drop: ${job.title} (${context.profile})`);
        log().info(`remove started: ${target} (job ${job.id})`);
        return send(res, 200, { jobId: job.id });
      }
      return send(res, 404, { error: `no route ${method} ${route}` });
    } catch (cause) {
      const status = cause instanceof StageError || cause instanceof InstallError ? cause.status : 500;
      const message = cause instanceof Error ? cause.message : String(cause);
      logger?.warn?.(`plugin-drop: ${message}`);
      log().warn(`${method} ${route} → ${status}: ${message}`);
      return send(res, status, { error: message });
    }
  };

  // The dashboard half runs in its own fiber so a composition without an HTTP
  // server cannot take the plugin down with it, and so the routes register
  // whenever `webServer` appears rather than only if it is already there.
  ctx.inject(['webServer'], scoped => {
    scoped.effect(
      () => scoped.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
      'plugin-drop: installer routes',
    );
    logger?.info?.(`plugin-drop: installer page mounted at ${ROUTE}/`);
  });
}

export default { name, apply };
