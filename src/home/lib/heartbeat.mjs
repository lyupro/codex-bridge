/**
 * The one definition of run progress: a heartbeat file in the run folder, its age, and the
 * stale threshold. On 2026-08-06 run 2026-08-06_204007_build left a live worker waiting on
 * Codex's grandchild; a worker timer alone would have kept that dead run looking alive, so
 * the timer stops at exit. The file's modification time is the run's best-effort sign of recent
 * progress. A failed stamp is swallowed so this hint cannot prevent the run's normal verdict and
 * artifacts. For an old record, a missing file is a legacy state that keeps its lock until its pid
 * dies.
 */
import fs from 'node:fs';
import path from 'node:path';

export const HEARTBEAT_FILE = 'heartbeat';
// Ten seconds bounds metadata writes when a 300KB stream arrives as many chunks; output still
// proves movement immediately in memory, while the periodic worker stamp keeps silence fresh.
export const HEARTBEAT_WRITE_INTERVAL_MS = 10_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
// Five minutes leaves a wide margin over the longest model-thinking silence seen in healthy
// runs. The active-child timer refreshes below it; the margin is safer than unlocking a tree
// while a working build is silent, which is the failure this heartbeat exists to prevent.
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

export function heartbeatPath(runDir) {
  return path.join(runDir, HEARTBEAT_FILE);
}

/** A failed stamp is deliberately swallowed: the verdict must not depend on this hint file. */
export function createHeartbeat(runDir) {
  let lastStamp = Number.NEGATIVE_INFINITY;
  return {
    stamp(now = Date.now()) {
      if (!Number.isFinite(now)) return;
      if (now >= lastStamp && now - lastStamp < HEARTBEAT_WRITE_INTERVAL_MS) return;
      lastStamp = now;
      try {
        fs.writeFileSync(heartbeatPath(runDir), `${now}\n`);
      } catch {
        // A read-only or full run folder must still produce its normal verdict and artifacts.
      }
    },
  };
}

/** Missing is an explicit legacy state: old live records keep their lock until their pid dies. */
export function heartbeatAge(runDir, now = Date.now()) {
  try {
    const stat = fs.statSync(heartbeatPath(runDir));
    if (!stat.isFile() || !Number.isFinite(now)) return Number.POSITIVE_INFINITY;
    return Math.max(0, now - stat.mtimeMs);
  } catch (err) {
    return err.code === 'ENOENT' ? null : Number.POSITIVE_INFINITY;
  }
}

/**
 * How long a run has been silent, in words. It lives beside the age it formats because both the
 * worktree lock's refusal and `unlock`'s report have to name the same silence to the same operator;
 * two copies of this drifted apart the moment they were written.
 */
export function formatSilence(age) {
  if (age === null || !Number.isFinite(age)) return 'an unknown duration';
  const seconds = Math.floor(Math.max(0, age) / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
      + (remainingSeconds ? ` ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}` : '');
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours} hour${hours === 1 ? '' : 's'}`
    + (remainingMinutes ? ` ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}` : '');
}

/**
 * A running record is live when its heartbeat is fresh. Missing heartbeats remain live only for
 * pre-Plan_20 records, an explicit fail-closed compatibility choice that preserves their lock.
 */
export function isHeartbeatFresh(runDir, now = Date.now()) {
  const age = heartbeatAge(runDir, now);
  return age === null || age <= HEARTBEAT_STALE_MS;
}
