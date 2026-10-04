/**
 * An append-only log beside the staging root.
 *
 * A profile plugin cannot rely on the host's logger being reachable (and its
 * output is not visible in the desktop application's log file), so every stage,
 * install, removal, and failure is recorded where a person can actually read it:
 * `<DSH_HOME>/plugin-drop/plugin-drop.log`.
 *
 * Writing a log must never be able to fail an operation, so every call swallows
 * its own errors.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The log file a home keeps, whether or not it exists yet. */
export function logPathFor(home) {
  return path.join(home ?? process.env.DSH_HOME ?? '.', 'plugin-drop', 'plugin-drop.log');
}

/** The most the log keeps before it is rotated once. */
const MAX_LOG_BYTES = 1024 * 1024;

/** One timestamped line, best effort. */
function append(file, level, message) {
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${message}\n`);
  } catch {
    // A log that cannot be written must not break the operation it describes.
  }
}

/**
 * Open (or create) the log for a home.
 * @param home The DSH home, or null to fall back to the environment.
 * @returns the logger, whose `path` the page reports to the reader.
 */
export function createLogFile(home) {
  const file = logPathFor(home);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    // A missing directory is retried by the first append.
  }
  return {
    path: file,
    info: message => append(file, 'info', message),
    warn: message => append(file, 'warn', message),
    error: message => append(file, 'error', message),
  };
}
