/**
 * Owns temporary test-tree cleanup. The 2026-08-24 deadline regression exposed both reasons
 * this is shared: full-suite load let an honest early exit lose a deadline race, and Windows
 * returned EPERM while a detached grandchild still held its working directory. Windows may
 * release that directory shortly after the process dies, so transient removal failures retry;
 * every other failure stays loud so the suite cannot silently litter the operator's temp dir.
 *
 * It owns creation for the same reason: creation is where the responsibility for removal is handed
 * out. Trees are made inside the suite's own root (`CODEX_BRIDGE_TEST_TMP`, from `npm test`) and
 * swept when the importing test file finishes, so a caller cannot forget what it never had to do.
 */
import fs from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';

const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
const REMOVE_TIMEOUT_MS = 2_000;
const RETRY_DELAY_MS = 25;
const registeredTrees = new Set();

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Registered here, once, when a test file imports the helper — never by the test that creates a
// tree. Fixtures used to create trees that nobody removed (24 files called them, one cleaned up),
// and an obligation a caller can forget is not a mechanism. Sweeping every tree, then failing on
// what is left, keeps one stuck directory from hiding the rest.
after(async () => {
  const failures = [];
  for (const dir of [...registeredTrees]) {
    try {
      await removeTempTree(dir);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, `Failed to sweep ${failures.length} temporary tree(s)`);
  }
});

export function makeTempTree(prefix) {
  const root = process.env.CODEX_BRIDGE_TEST_TMP;
  if (!root) {
    throw new Error(
      'CODEX_BRIDGE_TEST_TMP is not set: the suite was started outside npm test, which provides a throwaway root.',
    );
  }
  const dir = fs.mkdtempSync(path.join(root, prefix));
  registeredTrees.add(dir);
  return dir;
}

export async function removeTempTree(dir) {
  const deadline = Date.now() + REMOVE_TIMEOUT_MS;
  let lastError;
  for (;;) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
      registeredTrees.delete(dir);
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
