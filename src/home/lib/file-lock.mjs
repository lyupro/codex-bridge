/**
 * Plan_56 D44: three concurrent model-set processes lost an edit after every byte comparison
 * passed. Reuse the registry's Windows-hardened lock so both writers share one exclusion contract.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

function waitForLock(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * A lock nobody released is worse than no lock: interrupting an install left the file behind and
 * every later install and uninstall died on it until someone deleted it by hand (reproduced
 * 2026-08-04). An owner update takes milliseconds, so a lock older than the staleness window
 * belongs to a process that is gone.
 */
async function dropStaleLock(lockPath, staleMs) {
  try {
    const { mtimeMs } = await fs.stat(lockPath);
    if (Date.now() - mtimeMs < staleMs) return false;
    await fs.rm(lockPath, { force: true });
    return true;
  } catch {
    // Vanished or unreadable — let the next open() decide rather than guess here.
    return false;
  }
}

/**
 * Windows answers a taken lock with three different codes, and only one of them is EEXIST. A file
 * whose last handle closed while a delete was pending stays visible but refuses to be opened:
 * `open(..., 'wx')` comes back EPERM, and a file another process still holds comes back EBUSY.
 * Treating those as fatal is what made `tests/cli/rules-owners.test.mjs` fail twice on 2026-08-11
 * with EPERM on the lock file — the suite went red over a lock that was simply busy for one more
 * millisecond. All three mean the same thing to a caller waiting for a lock: not yours yet.
 */
const LOCK_TAKEN_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY']);

/** Exported so the retry contract is asserted directly; the race itself reproduces only by luck. */
export function isLockTaken(err) {
  return LOCK_TAKEN_CODES.has(err?.code);
}

async function acquireFileLock(lockPath, { retries, delayMs, staleMs, description }) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  let lastTaken;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      return { handle, lockPath };
    } catch (err) {
      if (!isLockTaken(err)) throw err;
      lastTaken = err;
      if (!(await dropStaleLock(lockPath, staleMs))) await waitForLock(delayMs);
    }
  }
  // The code is part of the message: a timeout on EPERM points at a delete that never completed,
  // a timeout on EEXIST at an owner that never released.
  throw new Error(
    `timed out waiting for ${description} lock: ${lockPath} (last attempt: ${lastTaken.code})`,
    { cause: lastTaken },
  );
}

export async function withFileLock(lockPath, action, {
  retries = 200, delayMs = 5, staleMs = 30_000, description = 'file',
} = {}) {
  const lock = await acquireFileLock(lockPath, { retries, delayMs, staleMs, description });
  try {
    return await action();
  } finally {
    await lock.handle.close().catch(() => {});
    await fs.rm(lock.lockPath, { force: true }).catch(() => {});
  }
}
