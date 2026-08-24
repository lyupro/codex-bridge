/**
 * Owns temporary test-tree cleanup. The 2026-08-24 deadline regression exposed both reasons
 * this is shared: full-suite load let an honest early exit lose a deadline race, and Windows
 * returned EPERM while a detached grandchild still held its working directory. Windows may
 * release that directory shortly after the process dies, so transient removal failures retry;
 * every other failure stays loud so the suite cannot silently litter the operator's temp dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
const REMOVE_TIMEOUT_MS = 2_000;
const RETRY_DELAY_MS = 25;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function makeTempTree(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function removeTempTree(dir) {
  const deadline = Date.now() + REMOVE_TIMEOUT_MS;
  let lastError;
  for (;;) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_CODES.has(error.code) || Date.now() >= deadline) {
        throw new Error(`Failed to remove temporary tree: ${dir}`, { cause: lastError });
      }
      await wait(RETRY_DELAY_MS);
    }
  }
}

export async function withTempTree(prefix, work) {
  const dir = makeTempTree(prefix);
  try {
    return await work(dir);
  } finally {
    await removeTempTree(dir);
  }
}
