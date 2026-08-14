/** Owns the transport list and age decision shared by automatic and manual cleanup. */
import fs from 'node:fs';
import path from 'node:path';
import { liveRuns, normalizePath } from '../hooks/live-runs.mjs';

// Plan_17 step 3 found one order's copied list and age default diverging on the same day. Keeping
// the transport boundary here prevents automatic cleanup from eating accounting files.
export const TRANSPORT_FILES = Object.freeze(['events.jsonl', 'stderr.log', 'raw.log']);

function ageDate(name) {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})(?:_|$)/.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const timestamp = Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second),
  );
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
    || date.getUTCHours() !== Number(hour)
    || date.getUTCMinutes() !== Number(minute)
    || date.getUTCSeconds() !== Number(second)) return null;
  return timestamp;
}

function nowTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function ageCutoff(olderThan, now) {
  if (!olderThan) return null;
  if (olderThan.kind === 'duration') {
    const unit = olderThan.unit === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return now - olderThan.amount * unit;
  }
  return Date.parse(`${olderThan.date}T00:00:00.000Z`);
}

/** Returns whether a run is older than a parsed threshold, using only its folder name. */
export function runIsOlderThan(runName, olderThan, now = Date.now()) {
  const timestamp = ageDate(runName);
  if (timestamp === null || !olderThan) return false;
  return timestamp < ageCutoff(olderThan, nowTimestamp(now));
}

/**
 * Removes only regular transport files from old, non-live runs.
 *
 * Plan_17 step 4 makes cleanup deliberately best effort: a full disk must not stop a new run, and
 * deleting one named file cannot justify recursive removal of a run folder or accounting artifacts.
 */
export function cleanupRetention(runsDir, config, options = {}) {
  // Do not inspect days when disabled. A stale or malformed day value must not re-enable cleanup.
  if (!config?.enabled) return null;
  const days = config.days;
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return null;

  const filesystem = options.fs || fs;
  const now = options.now ?? Date.now();
  let entries;
  try {
    entries = filesystem.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let live = new Set();
  try {
    // Normalized like every other path comparison in the package: a case difference between the
    // scan and the probe would make a live run look like a stale one, and this deletes files.
    live = new Set(liveRuns(runsDir).map(({ dir }) => normalizePath(dir)));
  } catch {
    // The launcher wraps the whole pass too; when the shared probe cannot answer, retain every
    // run rather than repeating the abandoned-run incident with a live folder as a target.
    return null;
  }

  const removedRuns = new Set();
  let bytesFreed = 0;
  for (const entry of entries) {
    let isDirectory;
    try {
      isDirectory = entry.isDirectory();
    } catch {
      continue;
    }
    if (!isDirectory) continue;

    const runDir = path.join(runsDir, entry.name);
    if (live.has(normalizePath(runDir)) || !runIsOlderThan(entry.name, {
      kind: 'duration',
      amount: days,
      unit: 'd',
    }, now)) continue;

    for (const filename of TRANSPORT_FILES) {
      const target = path.join(runDir, filename);
      let stat;
      try {
        stat = filesystem.lstatSync(target);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      try {
        filesystem.unlinkSync(target);
      } catch {
        continue;
      }
      removedRuns.add(entry.name);
      if (Number.isFinite(stat.size) && stat.size > 0) bytesFreed += stat.size;
    }
  }

  return removedRuns.size ? { bytes_freed: bytesFreed, runs: removedRuns.size, days } : null;
}
