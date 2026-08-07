/**
 * Shared, fail-open knowledge of live Codex runs.
 *
 * The reply guard and the worktree lock must answer the same question: a status.json is live
 * only while it says `running`, its runner pid accepts signal 0, and its progress heartbeat is
 * fresh. Keeping those probes and the directory scan here prevents the two protections from
 * disagreeing about a run, which would recreate the 2026-08-06 incident where a dead Codex
 * child left its worker and lock looking live through a grandchild-held stdio pipe.
 *
 * The heartbeat is required here and deliberately NOT in meta/run-state.mjs: releasing a lock
 * early costs an operator one knowing edit, while closing a record early makes a second writer
 * of its meta.json. See the comment above pidAlive() there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isHeartbeatFresh } from '../heartbeat.mjs';

/** Signal 0 tests existence without stopping the process; EPERM still means that it exists. */
export const isPidAlive = (pid) => {
  if (typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/**
 * Match the package's repository comparison without resolving symlinks: Windows realpath adds
 * `\\?\\` and UNC spellings, turning equal paths into unequal ones. A null result is uncertainty,
 * and callers must pass rather than deny on it.
 */
export function normalizePath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    let normalized = path.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '');
    if (!normalized) normalized = '/';
    if (process.platform === 'win32') normalized = normalized.toLowerCase();
    return normalized;
  } catch {
    return null;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function recognizedStatus(runDir, status) {
  return Boolean(status)
    && typeof status === 'object'
    && !Array.isArray(status)
    && status.state === 'running'
    && typeof status.pid === 'number'
    && isNonEmptyString(status.agent)
    && isNonEmptyString(status.slug)
    && isNonEmptyString(status.repo)
    && isPidAlive(status.pid)
    && isHeartbeatFresh(runDir);
}

function readStatus(runDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Scan one project's direct run folders; unreadable or unfamiliar entries are ignored. */
export function liveRuns(runsDir) {
  if (typeof runsDir !== 'string' || !runsDir.trim()) return [];
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsDir, entry.name);
    const status = readStatus(dir);
    if (recognizedStatus(dir, status)) result.push({ dir, status });
  }
  return result;
}

/** Scan every project under the configured runs root for worktree ownership. */
export function allLiveRuns(runsRoot) {
  if (typeof runsRoot !== 'string' || !runsRoot.trim()) return [];
  let projects;
  try {
    projects = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    result.push(...liveRuns(path.join(runsRoot, project.name)));
  }
  return result;
}
