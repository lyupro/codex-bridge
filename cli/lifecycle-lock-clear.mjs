/**
 * Removes a crashed holder's file lock, and only that (Plan_65 D11). D8 forbids ever removing a live
 * holder's lock; advice A14 showed two clearers that both read dead holder X can remove the lock a new
 * holder Y created in between, so clearers queue on a gate file taken before the authoritative read.
 * Rename-then-verify is forbidden: moving a replacement live lock already frees its name.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
import { holderLiveness, lifecycleLockStrategy, parseHolder } from './lifecycle-lock.mjs';

const ARTIFACT_ID = 'install-record';
const errorReason = (error) => error?.code || error?.message || String(error);

async function clearHeldGate(lockPath, identity, writer) {
  let before;
  try {
    before = await fsp.lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { outcome: 'free' };
    throw error;
  }
  if (!before.isFile()) return { outcome: 'refused', reason: 'not a regular file' };
  const content = await fsp.readFile(lockPath);
  const holder = parseHolder(content.toString('utf8').split(/\r?\n/, 1)[0]);
  if (!holder) return { outcome: 'refused', reason: 'holder record is unreadable or incomplete' };
  const liveness = holderLiveness(holder, identity);
  if (liveness !== 'dead') return { outcome: 'refused', reason: `the holder process is ${liveness}`, holder };

  let current;
  let after;
  try {
    current = await fsp.readFile(lockPath);
    after = await fsp.lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { outcome: 'refused', reason: 'the lock changed while clearing', holder };
    }
    return { outcome: 'refused', reason: errorReason(error), holder };
  }
  if (!after.isFile() || !content.equals(current)
    || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    return { outcome: 'refused', reason: 'the lock changed while clearing', holder };
  }
  try {
    await writer.unlink(ARTIFACT_ID, lockPath);
  } catch (error) {
    return { outcome: 'refused', reason: errorReason(error), holder };
  }
  try {
    await fsp.lstat(lockPath);
    return { outcome: 'refused', reason: 'the lock is still present after clearing', holder };
  } catch (error) {
    if (error?.code === 'ENOENT') return { outcome: 'cleared', holder };
    return { outcome: 'refused', reason: errorReason(error), holder };
  }
}

export async function clearLifecycleLock(homeRoot, {
  platform = process.platform,
  identity = {},
  writer,
} = {}) {
  const strategy = lifecycleLockStrategy(platform);
  const lockPath = strategy === 'file' ? path.join(homeRoot, '.installed.json.lock') : undefined;
  const base = { homeRoot, strategy, ...(lockPath === undefined ? {} : { lockPath }) };
  const gatePath = lockPath === undefined ? undefined : `${lockPath}.clear`;
  let handle;
  let result;
  try {
    let home;
    try {
      home = await fsp.stat(homeRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...base, outcome: 'no-home' };
      throw error;
    }
    if (!home.isDirectory()) return { ...base, outcome: 'refused', reason: 'home is not a directory' };
    if (strategy !== 'file') return { ...base, outcome: 'kernel-managed' };
    writer ??= createHomeWriter({ root: homeRoot });
    try {
      handle = await writer.open(ARTIFACT_ID, gatePath, 'wx');
    } catch (error) {
      if (error?.code === 'EEXIST') return { ...base, outcome: 'gate-busy', gatePath };
      throw error;
    }
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    result = { ...base, ...await clearHeldGate(lockPath, identity, writer) };
  } catch (error) {
    result = { ...base, outcome: 'refused', reason: errorReason(error) };
  } finally {
    if (handle) {
      // The outcome already happened: a gate that cannot be closed must not turn a removed lock into
      // "nothing was removed". If it also cannot be unlinked, gateLeft below names it.
      await handle.close().catch(() => {});
      try {
        await writer.unlink(ARTIFACT_ID, gatePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') result = { ...result, gateLeft: gatePath };
      }
    }
  }
  return result;
}
