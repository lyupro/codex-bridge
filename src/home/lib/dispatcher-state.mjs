/** Keeps dispatcher handback evidence under the package state home without trusting hook ids as paths. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-json.mjs';
import { parseJsonText } from './json-file.mjs';
import { withFileLock } from './file-lock.mjs';

function assertIdentity(sessionId, agentId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0
    || typeof agentId !== 'string' || agentId.length === 0) {
    throw new TypeError('sessionId and agentId must be non-empty strings');
  }
}

export function dispatcherStatePath({ stateDir, sessionId, agentId }) {
  assertIdentity(sessionId, agentId);
  const digest = createHash('sha256').update(`${sessionId}\n${agentId}`).digest('hex').slice(0, 32);
  return path.join(stateDir, 'dispatchers', `${digest}.json`);
}

export function readDispatcherState(ids) {
  const file = dispatcherStatePath(ids);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  let record;
  try {
    record = parseJsonText(file, source);
  } catch {
    return { corrupt: true };
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || record.sessionId !== ids.sessionId || record.agentId !== ids.agentId) {
    return { corrupt: true };
  }
  return record;
}

function timestamp(value) {
  return new Date(value).toISOString();
}

function clockValue(ids) {
  return typeof ids.now === 'function' ? ids.now() : (ids.now ?? Date.now());
}


export async function updateDispatcherState(ids, mutate) {
  if (typeof mutate !== 'function') throw new TypeError('mutate must be a function');
  const file = dispatcherStatePath(ids);
  const { sessionId, agentId } = ids;
  return withFileLock(`${file}.lock`, async () => {
    let current = readDispatcherState(ids);
    if (current === null) {
      current = { sessionId, agentId, createdAt: timestamp(clockValue(ids)) };
    }
    const result = await mutate(current);
    const candidate = result === undefined ? current : result;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TypeError('mutate must produce a JSON record object');
    }
    const record = {
      ...candidate,
      sessionId,
      agentId,
      updatedAt: timestamp(clockValue(ids)),
    };
    writeJsonAtomic(file, record);
    return record;
  }, { description: 'dispatcher state' });
}

export function pruneDispatcherStates({ stateDir, olderThanMs = 7 * 24 * 3600 * 1000, now = Date.now() }) {
  const directory = path.join(stateDir, 'dispatchers');
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }

  const cutoff = now - olderThanMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(directory, entry.name);
    let old;
    try {
      old = fs.statSync(file).mtimeMs < cutoff;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!old) continue;
    try {
      fs.unlinkSync(file);
      removed += 1;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.rmSync(`${file}.lock`, { force: true });
  }
  return removed;
}
