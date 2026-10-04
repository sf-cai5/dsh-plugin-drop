/**
 * A minimal ZIP reader — just enough for the archives a person drops onto the
 * installer page, with no dependency to fetch and no native module to build.
 *
 * Supported: store (0) and deflate (8) entries, UTF-8 and legacy (GBK/CP437)
 * file names, and the usual Windows/Explorer archives. ZIP64 archives are
 * refused with an explicit message rather than misread.
 */
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** The comment length field is 16 bits, so the record starts within this many bytes of the end. */
const EOCD_SEARCH_LIMIT = EOCD_MIN_SIZE + 0xffff;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const UTF8_FLAG = 0x800;
const DIRECTORY_ATTRIBUTE = 0x10;

/** A malformed or unsupported archive, worded for the person who dropped it. */
export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

/** The table the central directory holds for one entry. */
function readCentralEntries(buffer, offset, count) {
  const entries = [];
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError('the archive central directory is truncated or malformed');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const time = buffer.readUInt16LE(cursor + 12);
    const date = buffer.readUInt16LE(cursor + 14);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    entries.push({
      name: decodeName(nameBytes, flags),
      flags,
      method,
      time,
      date,
      crc,
      compressedSize,
      uncompressedSize,
      isDirectory: nameBytes.length > 0 && nameBytes[nameBytes.length - 1] === 0x2f
        ? true
        : (externalAttributes & DIRECTORY_ATTRIBUTE) !== 0,
      localOffset,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Locate the end-of-central-directory record, which is the only fixed anchor in a ZIP. */
function findEndOfCentralDirectory(buffer) {
  const floor = Math.max(0, buffer.length - EOCD_SEARCH_LIMIT);
  for (let cursor = buffer.length - EOCD_MIN_SIZE; cursor >= floor; cursor -= 1) {
    if (buffer.readUInt32LE(cursor) === EOCD_SIGNATURE) return cursor;
  }
  throw new ZipError('this file is not a ZIP archive');
}

/**
 * Decode an entry name. The UTF-8 flag is authoritative; archives written by
 * Windows Explorer on a Chinese system set neither it nor UTF-8 bytes, so a
 * strict UTF-8 decode that fails falls back to the system code page.
 */
function decodeName(bytes, flags) {
  if (bytes.length === 0) return '';
  if ((flags & UTF8_FLAG) !== 0) return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    for (const label of ['gbk', 'windows-1252']) {
      try {
        return new TextDecoder(label, { fatal: true }).decode(bytes);
      } catch {
        // Try the next code page.
      }
    }
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Whether a name escapes the extraction root or is otherwise unsafe as a relative path. */
export function isUnsafeEntryName(name) {
  const normalized = name.replace(/\\/gu, '/');
  if (normalized === '' || normalized.startsWith('/')) return true;
  if (/^[a-zA-Z]:/u.test(normalized)) return true;
  return normalized.split('/').some(segment => segment === '..');
}

/** Normalize an entry name to forward-slash relative form. */
export function normalizeEntryName(name) {
  return name.replace(/\\/gu, '/').replace(/^\.\//u, '');
}

/** CRC-32, so a truncated or corrupted archive is reported instead of half-extracted. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** @returns the CRC-32 of a buffer, as an unsigned 32-bit number. */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) crc = (CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

/** Convert a DOS date/time pair into a JavaScript date, or null when it is unset. */
function dosDateTime(date, time) {
  const year = ((date >> 9) & 0x7f) + 1980;
  const month = (date >> 5) & 0x0f;
  const day = date & 0x1f;
  const hours = (time >> 11) & 0x1f;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(year, month - 1, day, hours, minutes, seconds);
}

/** Read one entry's bytes out of the archive, verifying its CRC. */
function readEntryData(buffer, entry) {
  const cursor = entry.localOffset;
  if (cursor + 30 > buffer.length || buffer.readUInt32LE(cursor) !== LOCAL_SIGNATURE) {
    throw new ZipError(`the archive entry ${entry.name} has no usable local header`);
  }
  const nameLength = buffer.readUInt16LE(cursor + 26);
  const extraLength = buffer.readUInt16LE(cursor + 28);
  const start = cursor + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw new ZipError(`the archive entry ${entry.name} is truncated`);
  const raw = buffer.subarray(start, end);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw);
    } catch (cause) {
      throw new ZipError(`the archive entry ${entry.name} could not be decompressed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  throw new ZipError(`the archive entry ${entry.name} uses unsupported compression method ${entry.method}`);
}

/**
 * Extract an archive into `destDir`, creating directories as needed.
 * @param buffer The whole archive.
 * @param destDir Absolute destination directory.
 * @param options `skip` predicate on normalized names and an `onEntry` progress callback.
 * @returns the extracted file count.
 */
export function extractZip(buffer, destDir, options = {}) {
  const skip = options.skip ?? (() => false);
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count === ZIP64_SENTINEL_16 || directoryOffset === ZIP64_SENTINEL_32 || directorySize === ZIP64_SENTINEL_32) {
    throw new ZipError('ZIP64 archives are not supported; re-zip the folder without ZIP64 or drop the folder itself');
  }
  if (directoryOffset + directorySize > buffer.length) throw new ZipError('the archive central directory is out of range');
  const entries = readCentralEntries(buffer, directoryOffset, count);
  let written = 0;
  for (const entry of entries) {
    const name = normalizeEntryName(entry.name);
    if (name === '' || isUnsafeEntryName(entry.name)) throw new ZipError(`the archive contains an unsafe path: ${entry.name}`);
    if (skip(name)) continue;
    const target = path.join(destDir, ...name.split('/').filter(segment => segment !== ''));
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    const data = readEntryData(buffer, entry);
    if (entry.uncompressedSize !== 0 && data.length !== entry.uncompressedSize) {
      throw new ZipError(`the archive entry ${entry.name} has an unexpected size`);
    }
    const actual = crc32(data);
    if (entry.crc !== 0 && actual !== entry.crc) throw new ZipError(`the archive entry ${entry.name} is corrupted (CRC mismatch)`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    const stamp = dosDateTime(entry.date, entry.time);
    if (stamp !== null) {
      try {
        fs.utimesSync(target, stamp, stamp);
      } catch {
        // A file system that refuses the timestamp keeps the extraction result.
      }
    }
    written += 1;
    options.onEntry?.(name);
  }
  return written;
}
