/**
 * Shared, fail-open knowledge of live Codex runs.
 *
 * The reply guard and the worktree lock must answer the same question: a status.json is live
 * only while it says `running`, its runner pid is judged alive for this run, and its progress
 * heartbeat is fresh. Keeping those probes and the directory scan here prevents the two protections from
 * disagreeing about a run, which would recreate the 2026-08-06 incident where a dead Codex
 * child left its worker and lock looking live through a grandchild-held stdio pipe.
 *
 * The heartbeat is required here and deliberately NOT in meta/run-state.mjs: releasing a lock
 * early costs an operator one knowing edit, while closing a record early makes a second writer
 * of its meta.json. See the comment above pidAlive() there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { heartbeatAge, isHeartbeatFresh } from '../lib/heartbeat.mjs';
import { readJsonFileSync } from '../lib/json-file.mjs';
import {
  IDENTITY_ALIVE,
  IDENTITY_DEAD,
  IDENTITY_FOREIGN,
  processIdentity,
} from '../lib/process-identity.mjs';

export const RECENT_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * The hook requires pid judgment plus a fresh heartbeat. Identity uncertainty stays live here
 * (fail-open), while the identity module deliberately treats a missing heartbeat as unverified;
 * isHeartbeatFresh() keeps its pre-Plan_20 missing-file compatibility for this separate question.
 */
// Plan_31 needs confirmed process identity before warning about paid work that TaskStop leaves
// behind; existing lock/reply guards retain the fail-open default for uncertain identities.
export const isPidAlive = (pid, runDir, status = {}, options = {}) => {
  const identity = processIdentity({ runDir, status: { ...status, pid } });
  if (options.requireConfirmedIdentity === true) return identity === IDENTITY_ALIVE;
  return identity !== IDENTITY_DEAD && identity !== IDENTITY_FOREIGN;
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

function recognizedStatus(runDir, status, options) {
  const heartbeatFresh = isHeartbeatFresh(runDir)
    && (options.requireConfirmedIdentity !== true || heartbeatAge(runDir) !== null);
  return Boolean(status)
    && typeof status === 'object'
    && !Array.isArray(status)
    && status.state === 'running'
    && typeof status.pid === 'number'
    && isNonEmptyString(status.agent)
    && isNonEmptyString(status.slug)
    && isNonEmptyString(status.repo)
    && heartbeatFresh
    && isPidAlive(status.pid, runDir, status, options);
}

function readStatus(runDir) {
  try {
    return readJsonFileSync(path.join(runDir, 'status.json'));
  } catch {
    return null;
  }
}

/** Scan one project's direct run folders; unreadable or unfamiliar entries are ignored. */
export function liveRuns(runsDir, options = {}) {
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
    if (recognizedStatus(dir, status, options)) result.push({ dir, status });
  }
  return result;
}

/**
 * Find runs recent enough to explain the current dispatcher reply, including completed runs.
 * The 24-hour window covers long and overnight dispatches without letting old project history
 * explain a new reply. This closes the August 13 incident where a fabricated FAIL hid a
 * finished/OK run simply by omitting its folder. Null means the disk could not be trusted.
 */
export function recentRuns(runsDir, options = {}) {
  if (typeof runsDir !== 'string' || !runsDir.trim()) return null;
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? RECENT_RUN_MAX_AGE_MS;
  let entries;
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch (err) {
    return err.code === 'ENOENT' ? [] : null;
  }

  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(runsDir, entry.name);
    const statusPath = path.join(dir, 'status.json');
    if (!fs.existsSync(statusPath)) continue;
    let status;
    try {
      status = readJsonFileSync(statusPath);
    } catch {
      return null;
    }
    if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
    if (options.agent && status.agent !== options.agent) continue;
    const timestamp = Date.parse(status.finished_at || status.started_at || '');
    if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > maxAgeMs) continue;
    result.push({ dir, status, timestamp });
  }
  return result.sort((a, b) => b.timestamp - a.timestamp);
}

/** Scan every project under the configured runs root for worktree ownership. */
export function allLiveRuns(runsRoot, options = {}) {
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
    result.push(...liveRuns(path.join(runsRoot, project.name), options));
  }
  return result;
}
