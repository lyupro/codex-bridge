/** Tracks which Claude Code hosts own the shared Codex bridge rules file. */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeRepoPath } from '../src/runner/project-dir.mjs';
import { readJsonFile } from '../src/json-file.mjs';

export const RULES_REGISTRY_NAME = '.codex-bridge-rules.json';
export const RULES_REGISTRY_VERSION = 1;

const REGISTRY_LOCK_RETRIES = 200;
const REGISTRY_LOCK_DELAY_MS = 5;
const REGISTRY_LOCK_STALE_MS = 30_000;

export function rulesRegistryPath(host) {
  return path.join(host.codexRulesDir, RULES_REGISTRY_NAME);
}

export function normalizedRulesOwner(host) {
  return normalizeRepoPath(host.root);
}

function normalizeOwners(owners) {
  return [...new Set(owners.map((owner) => normalizeRepoPath(owner)))];
}

function validateRegistry(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('rules ownership registry must be an object');
  }
  if (parsed.version !== RULES_REGISTRY_VERSION) {
    throw new Error(`rules ownership registry version must be ${RULES_REGISTRY_VERSION}`);
  }
  if (!Array.isArray(parsed.owners) || parsed.owners.some((owner) => typeof owner !== 'string' || !owner)) {
    throw new Error('rules ownership registry owners must be a list of non-empty strings');
  }
  return {
    version: RULES_REGISTRY_VERSION,
    owners: normalizeOwners(parsed.owners),
  };
}

async function loadRulesRegistry(host) {
  let parsed;
  try {
    parsed = await readJsonFile(rulesRegistryPath(host));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err.cause) {
      throw new Error(`invalid rules ownership registry JSON: ${err.cause.message}`, { cause: err.cause });
    }
    throw err;
  }
  return { raw: parsed, registry: validateRegistry(parsed) };
}

function hasSameOwners(raw, registry) {
  return raw?.version === registry.version
    && Array.isArray(raw.owners)
    && raw.owners.length === registry.owners.length
    && raw.owners.every((owner, index) => owner === registry.owners[index]);
}

async function writeRulesRegistry(host, registry) {
  const target = rulesRegistryPath(host);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporary, target);
  } catch (err) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw err;
  }
}

function registryLockPath(host) {
  return `${rulesRegistryPath(host)}.lock`;
}

function waitForRegistryLock() {
  return new Promise((resolve) => setTimeout(resolve, REGISTRY_LOCK_DELAY_MS));
}

/**
 * A lock nobody released is worse than no lock: interrupting an install left the file behind and
 * every later install and uninstall died on it until someone deleted it by hand (reproduced
 * 2026-08-04). An owner update takes milliseconds, so a lock older than the staleness window
 * belongs to a process that is gone.
 */
async function dropStaleLock(lockPath) {
  try {
    const { mtimeMs } = await fs.stat(lockPath);
    if (Date.now() - mtimeMs < REGISTRY_LOCK_STALE_MS) return false;
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

async function acquireRegistryLock(host) {
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  const lockPath = registryLockPath(host);
  let lastTaken;
  for (let attempt = 0; attempt < REGISTRY_LOCK_RETRIES; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      return { handle, lockPath };
    } catch (err) {
      if (!isLockTaken(err)) throw err;
      lastTaken = err;
      if (!(await dropStaleLock(lockPath))) await waitForRegistryLock();
    }
  }
  // The code is part of the message: a timeout on EPERM points at a delete that never completed,
  // a timeout on EEXIST at an owner that never released.
  throw new Error(
    `timed out waiting for rules ownership registry lock: ${lockPath} (last attempt: ${lastTaken.code})`,
    { cause: lastTaken },
  );
}

async function withRegistryLock(host, action) {
  const lock = await acquireRegistryLock(host);
  try {
    return await action();
  } finally {
    await lock.handle.close().catch(() => {});
    await fs.rm(lock.lockPath, { force: true }).catch(() => {});
  }
}

export async function readRulesRegistry(host) {
  return (await loadRulesRegistry(host))?.registry ?? null;
}

export async function addRulesOwner(host) {
  await loadRulesRegistry(host);
  return withRegistryLock(host, async () => {
    // Read after locking so a concurrent installer is merged instead of overwritten.
    const loaded = await loadRulesRegistry(host);
    const owner = normalizedRulesOwner(host);
    const current = loaded?.registry || { version: RULES_REGISTRY_VERSION, owners: [] };
    const registry = {
      version: RULES_REGISTRY_VERSION,
      owners: normalizeOwners([...current.owners, owner]),
    };
    if (!loaded || !hasSameOwners(loaded.raw, registry)) await writeRulesRegistry(host, registry);
    return registry;
  });
}

export function remainingRulesOwners(registry, host) {
  if (!registry) return null;
  const owner = normalizedRulesOwner(host);
  return registry.owners.filter((candidate) => candidate !== owner);
}

export async function removeRulesOwner(host) {
  const initial = await loadRulesRegistry(host);
  if (!initial) return null;
  return withRegistryLock(host, async () => {
    const loaded = await loadRulesRegistry(host);
    if (!loaded) return null;
    const registry = {
      version: RULES_REGISTRY_VERSION,
      owners: remainingRulesOwners(loaded.registry, host),
    };
    if (registry.owners.length) {
      if (!hasSameOwners(loaded.raw, registry)) await writeRulesRegistry(host, registry);
    } else {
      await fs.rm(rulesRegistryPath(host), { force: true });
    }
    return registry;
  });
}
