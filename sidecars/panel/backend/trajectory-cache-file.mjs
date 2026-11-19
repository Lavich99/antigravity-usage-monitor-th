import {
  closeSync, copyFileSync, fstatSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writevSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';

let lastWrite = null;

function syncSleepMs(ms) {
  if (!(ms > 0)) return;
  try {
    if (typeof SharedArrayBuffer === 'function' && typeof Atomics?.wait === 'function') {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      return;
    }
  } catch {
    // Fallback to short busy yield if Atomics.wait is disallowed
  }
  const end = Date.now() + Math.min(ms, 50);
  while (Date.now() < end) {
    // brief spin fallback
  }
}

function commitTempFile(temporaryPath, filePath) {
  const retryDelays = [15, 30, 50, 80, 120];
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      renameSync(temporaryPath, filePath);
      return;
    } catch (err) {
      const code = err?.code;
      const isTransientWinLock = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!isTransientWinLock) throw err;
      if (attempt < retryDelays.length) {
        syncSleepMs(retryDelays[attempt]);
        continue;
      }
      copyFileSync(temporaryPath, filePath);
      return;
    }
  }
}

function isSameFile(a, b) {
  return b.ino !== 0n && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeNs === b.mtimeNs;
}

function readReusableBytes(filePath, expected) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const before = fstatSync(fd, { bigint: true });
    if (!isSameFile(before, expected) || before.ctimeNs !== expected.ctimeNs) return null;
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    return isSameFile(before, after) && before.ctimeNs === after.ctimeNs &&
      BigInt(bytes.length) === after.size ? bytes : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}


export function writeTrajectoryCacheFile(filePath, data) {
  const previous = lastWrite?.filePath === filePath ? lastWrite : null;
  const bytes = previous ? readReusableBytes(filePath, previous.file) : null;
  const ranges = new WeakMap();
  const parts = [];
  let position = 0;
  function append(part) {
    const buffer = typeof part === 'string' ? Buffer.from(part) : part;
    parts.push(buffer);
    position += buffer.length;
  }

  append('{');
  let separator = '';
  for (const [id, entry] of Object.entries(data)) {
    const { steps, ...metadata } = entry;
    const header = JSON.stringify(metadata);
    append(`${separator}${JSON.stringify(id)}:${header.slice(0, -1)}${header === '{}' ? '' : ','}"steps":`);
    const range = bytes && previous.ranges.get(steps);
    const start = position;
    append(range ? bytes.subarray(range.start, range.end) : JSON.stringify(steps));
    ranges.set(steps, { start, end: position });
    append('}');
    separator = ',';
  }
  append('}');

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporaryPath, 'wx');
    try {
      
      const batchSize = 256;
      for (let i = 0; i < parts.length; i += batchSize) {
        const batch = parts.slice(i, i + batchSize);
        const length = batch.reduce((sum, part) => sum + part.length, 0);
        if (writevSync(fd, batch) !== length) throw new Error('Incomplete cache write');
      }
    } finally {
      closeSync(fd);
    }
    const written = statSync(temporaryPath, { bigint: true });
    commitTempFile(temporaryPath, filePath);
    const file = statSync(filePath, { bigint: true });
    lastWrite = isSameFile(written, file) ? { filePath, file, ranges } : null;
  } finally {
    try { unlinkSync(temporaryPath); } catch {}
  }
}
