/**
 * Turning what a person dropped into something the official install operation
 * can consume: a directory that really is a plugin package, or a tarball.
 *
 * The browser can only hand over file *contents* — never the absolute path a
 * drop came from — so dropped folders are written into a staging directory
 * under DSH home. That directory is the installation source from then on
 * (a path install is recorded as `link:`), so it is deliberately stable
 * rather than temporary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractZip, ZipError } from './zip.js';

/** Directories that never belong to an installed plugin. */
export const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '__MACOSX', '.idea', '.vscode', '.cache', '.pnpm-store']);
/** Files that are editor or file-manager noise. */
export const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/** Archives the installer unpacks itself, versus tarballs pnpm can install directly. */
export const ZIP_EXTENSIONS = ['.zip'];
export const TARBALL_EXTENSIONS = ['.tgz', '.tar.gz'];

/** A staging or validation failure worded for the page. */
export class StageError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'StageError';
    this.status = status;
  }
}

/** Whether a dropped relative path is packaging noise rather than plugin content. */
export function shouldSkip(relative) {
  const segments = relative.replace(/\\/gu, '/').split('/').filter(segment => segment !== '');
  if (segments.some(segment => SKIP_DIRECTORIES.has(segment))) return true;
  return segments.length > 0 && SKIP_FILES.has(segments[segments.length - 1]);
}

/** Reject a name that would escape the destination directory. */
function assertSafeRelative(relative) {
  const normalized = relative.replace(/\\/gu, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/u.test(normalized)) throw new StageError(`dropped path is absolute, which is refused: ${relative}`);
  if (normalized.split('/').some(segment => segment === '..')) throw new StageError(`dropped path escapes the staging directory: ${relative}`);
  return normalized;
}

/** The classification of a dropped payload, derived from its file names. */
export function classifyDrop(names) {
  const plain = names.filter(name => !shouldSkip(name));
  if (plain.length === 1) {
    const only = plain[0].toLowerCase();
    if (ZIP_EXTENSIONS.some(extension => only.endsWith(extension))) return { kind: 'zip' };
    if (TARBALL_EXTENSIONS.some(extension => only.endsWith(extension))) return { kind: 'tarball' };
  }
  return { kind: 'folder' };
}

/** Write the uploaded files into a directory, skipping packaging noise. */
export function writeDroppedFiles(files, destDir) {
  let written = 0;
  let skipped = 0;
  for (const file of files) {
    const relative = assertSafeRelative(String(file.path ?? ''));
    if (relative === '') continue;
    if (shouldSkip(relative)) {
      skipped += 1;
      continue;
    }
    const target = path.join(destDir, ...relative.split('/').filter(segment => segment !== ''));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(String(file.data ?? ''), 'base64'));
    written += 1;
  }
  return { written, skipped };
}

/**
 * Find the package root inside an extracted or written tree: archives and
 * dropped folders usually carry one wrapper directory (`repo-main/`), and a
 * package.json is what marks the real root.
 */
export function resolvePluginRoot(dir) {
  let current = dir;
  for (let depth = 0; depth < 4; depth += 1) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const children = fs.readdirSync(current, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.'))
      .map(entry => entry.name);
    if (children.length !== 1) return current;
    current = path.join(current, children[0]);
  }
  return current;
}

/**
 * Read a staged package the way the profile will read it.
 * @param dir The plugin root directory.
 * @returns what the page needs to describe the package, and what the installer needs to judge it.
 */
export function inspectPluginDir(dir) {
  const manifestPath = path.join(dir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, name: null, version: null, description: null, hasBundlePatch: false, bundlePatch: null, problem: 'the dropped folder has no package.json, so it is not a DSH plugin package' };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (cause) {
    return { ok: false, name: null, version: null, description: null, hasBundlePatch: false, bundlePatch: null, problem: `package.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
  const bundlePatch = typeof manifest.dsh?.bundle?.patch === 'string' ? manifest.dsh.bundle.patch : null;
  const hasBundlePatch = bundlePatch !== null;
  const hasClient = manifest.dsh?.client !== undefined;
  const warnings = [];
  if (name === '') warnings.push('package.json declares no name');
  if (!hasBundlePatch) warnings.push('package.json declares no dsh.bundle.patch — it will install as a plain dependency, not a profile plugin layer');
  if (hasBundlePatch && !fs.existsSync(path.join(dir, bundlePatch))) warnings.push(`the bundle patch ${bundlePatch} is missing from the package`);
  return {
    ok: name !== '',
    name: name === '' ? null : name,
    version: typeof manifest.version === 'string' ? manifest.version : null,
    description: typeof manifest.description === 'string' ? manifest.description : null,
    hasBundlePatch,
    hasClient,
    bundlePatch,
    warnings,
    problem: name === '' ? 'package.json declares no name' : null,
  };
}

/** A filesystem-safe directory name for a staged package. */
function safeDirectoryName(name) {
  const cleaned = String(name).replace(/[^a-zA-Z0-9._@-]+/gu, '-').replace(/^[.-]+/u, '').replace(/[.-]+$/u, '');
  return cleaned === '' ? 'plugin' : cleaned.slice(0, 96);
}

/**
 * Materialize a dropped payload inside the staging root.
 * @param payload `{ files: [{ path, data }] }` as the page sends it, data base64.
 * @param stagingRoot Absolute directory that holds staged packages.
 * @returns the staged package: its root, how to install it, and what it is.
 */
export function stageDrop(payload, stagingRoot) {
  const files = Array.isArray(payload?.files) ? payload.files : [];
  if (files.length === 0) throw new StageError('nothing was dropped');
  const classification = classifyDrop(files.map(file => String(file.path ?? '')));
  fs.mkdirSync(stagingRoot, { recursive: true });

  if (classification.kind === 'tarball') {
    const file = files.find(candidate => !shouldSkip(String(candidate.path ?? ''))) ?? files[0];
    const originalName = path.posix.basename(String(file.path ?? 'package.tgz').replace(/\\/gu, '/'));
    const directory = fs.mkdtempSync(path.join(stagingRoot, 'tar-'));
    const target = path.join(directory, originalName);
    fs.writeFileSync(target, Buffer.from(String(file.data ?? ''), 'base64'));
    return {
      kind: 'tarball',
      stagingDirectory: directory,
      pluginDirectory: directory,
      installPath: target,
      fileCount: 1,
      skipped: 0,
      inspection: { ok: true, name: originalName, version: null, description: null, hasBundlePatch: true, bundlePatch: null, warnings: ['a tarball installs through pnpm, so its contents are read from the archive'], problem: null },
    };
  }

  const directory = fs.mkdtempSync(path.join(stagingRoot, classification.kind === 'zip' ? 'zip-' : 'drop-'));
  let fileCount = 0;
  let skipped = 0;
  if (classification.kind === 'zip') {
    const file = files.find(candidate => !shouldSkip(String(candidate.path ?? ''))) ?? files[0];
    const archive = Buffer.from(String(file.data ?? ''), 'base64');
    try {
      fileCount = extractZip(archive, directory, { skip: shouldSkip });
    } catch (cause) {
      fs.rmSync(directory, { recursive: true, force: true });
      if (cause instanceof ZipError) throw new StageError(`the dropped archive could not be unpacked: ${cause.message}`);
      throw cause;
    }
  } else {
    const result = writeDroppedFiles(files, directory);
    fileCount = result.written;
    skipped = result.skipped;
  }

  const root = resolvePluginRoot(directory);
  const inspection = inspectPluginDir(root);
  if (!inspection.ok) {
    // A payload that is not a package is not worth keeping on disk.
    fs.rmSync(directory, { recursive: true, force: true });
    throw new StageError(inspection.problem ?? 'the dropped content is not a DSH plugin package');
  }
  const finalDirectory = path.join(stagingRoot, `${safeDirectoryName(inspection.name)}`);
  return {
    kind: 'directory',
    stagingDirectory: directory,
    pluginDirectory: root,
    /** Renamed to a stable, predictable path once the package name is known. */
    preferredDirectory: finalDirectory,
    installPath: root,
    fileCount,
    skipped,
    inspection,
  };
}

/**
 * The packages currently staged under a staging root, newest first.
 *
 * A staged drop is not scratch space: a path install records `link:` to it, and
 * it is where a plugin keeps living. Listing what is on disk also lets a person
 * finish an install whose in-memory token is gone — after a host restart, or
 * when the response that carried the token never arrived.
 *
 * @param stagingRoot Absolute staging directory, which need not exist yet.
 * @returns one entry per staged package, with the details the page shows.
 */
export function describeStagedPackages(stagingRoot) {
  let entries;
  try {
    entries = fs.readdirSync(stagingRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(stagingRoot, entry.name);
    let root;
    try {
      root = resolvePluginRoot(directory);
    } catch {
      continue;
    }
    const inspection = inspectPluginDir(root);
    if (!inspection.ok) continue;
    let stagedAt = null;
    try {
      stagedAt = fs.statSync(root).mtime.toISOString();
    } catch {
      stagedAt = null;
    }
    found.push({
      id: entry.name,
      directory,
      installPath: root,
      name: inspection.name,
      version: inspection.version,
      hasBundlePatch: inspection.hasBundlePatch,
      hasClient: inspection.hasClient,
      warnings: inspection.warnings ?? [],
      stagedAt,
    });
  }
  return found.sort((left, right) => String(right.stagedAt).localeCompare(String(left.stagedAt)));
}

/**
 * Remove one staged package, named by any path inside it.
 *
 * The deletion is confined to a single top-level entry of the staging root, so a
 * request can never name something outside it — a staged directory is the live
 * source of an installed plugin, and deleting the wrong path would break that
 * install.
 *
 * @param stagingRoot Absolute staging directory.
 * @param target Absolute path inside the staged package to remove.
 * @returns the staged entry that was removed.
 */
export function removeStagedPackage(stagingRoot, target) {
  if (typeof target !== 'string' || target.trim() === '') throw new StageError('no staged path was given');
  const root = path.resolve(stagingRoot);
  const candidate = path.resolve(target);
  const relative = path.relative(root, candidate);
  const top = relative.split(path.sep)[0];
  if (relative === '' || top === '' || top === '..' || path.isAbsolute(relative)) {
    throw new StageError('that path is not inside the staging directory');
  }
  const entry = path.join(root, top);
  fs.rmSync(entry, { recursive: true, force: true });
  return entry;
}

/**
 * Move a staged package to its stable name.
 *
 * An installed path plugin is recorded as `link:`, so an existing directory of
 * the same name may be the live source of an earlier install. It is therefore
 * never replaced: a second drop of the same plugin keeps its own directory.
 */
export function adoptStableDirectory(staged) {
  const preferred = staged.preferredDirectory;
  if (preferred === undefined || preferred === staged.pluginDirectory) return staged;
  if (fs.existsSync(preferred)) return staged;
  const relativeRoot = path.relative(staged.stagingDirectory, staged.pluginDirectory);
  fs.mkdirSync(path.dirname(preferred), { recursive: true });
  try {
    fs.renameSync(staged.stagingDirectory, preferred);
  } catch {
    // A cross-device or locked rename keeps the uniquely named staging directory.
    return staged;
  }
  return { ...staged, pluginDirectory: path.join(preferred, relativeRoot), installPath: path.join(preferred, relativeRoot) };
}
