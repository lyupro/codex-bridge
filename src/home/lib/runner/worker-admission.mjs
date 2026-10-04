/**
 * Admits a worker and records its identity under its order claim before any paid work starts.
 * Plan_60 D4/D4c, A4 r4: a launcher killed after spawn frees the claim before recording the
 * detached worker, so a second launcher could abandon its run and start another paid run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFileSync } from '../json-file.mjs';
import { writeStatus } from '../meta/run-state.mjs';
import { acquireOrderClaim } from './order-claim.mjs';

export async function admitWorker({ runDir, orderId, timing, platform, createServer }) {
  const claim = await acquireOrderClaim({
    projectRunsRoot: path.dirname(runDir),
    orderId,
    role: 'worker',
    ...(timing !== undefined ? { timing } : {}),
    ...(platform !== undefined ? { platform } : {}),
    ...(createServer !== undefined ? { createServer } : {}),
  });
  try {
    if (claim.busy) return { admitted: false, reason: 'claim-timeout', holder: claim.holder };
    let status = null;
    try {
      status = readJsonFileSync(path.join(runDir, 'status.json'));
    } catch {
      // Plan_60 A4 r4: an unreadable run cannot authorize paid work after a launcher dies.
    }
    if (status?.state !== 'running' || fs.existsSync(path.join(runDir, 'meta.json'))) {
      return { admitted: false, reason: 'closed', state: status?.state ?? null };
    }
    // The launcher cannot know this detached process's clock origin; takeover must record the
    // worker's own identity before it starts producing the run's artifacts.
    writeStatus(runDir, {
      pid: process.pid,
      runner_pid: process.pid,
      process_started_at: performance.timeOrigin,
    });
    return { admitted: true };
  } finally {
    await claim.release?.();
  }
}
