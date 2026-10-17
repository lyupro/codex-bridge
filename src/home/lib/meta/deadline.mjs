/**
 * Reads the runner-owned deadline and silence watchdog stop facts from status.json.
 *
 * stderr.log is diagnostic text and can contain a quoted copy of the runner's own message,
 * so it cannot prove that the runner actually stopped the process (Plan_15).
 */
import path from 'node:path';
import { readJson } from './paths.mjs';

export function deadlineReason(runDir) {
  const status = readJson(path.join(runDir, 'status.json'));
  if (status?.stopped_on_deadline !== true) return null;
  // How long the run lived, not the budget it was given: a field named for the budget and
  // holding the elapsed time is read wrong by whoever opens the folder months later.
  const elapsed = status.elapsed_ms;
  return Number.isFinite(elapsed)
    ? `run stopped on its deadline after ${elapsed} ms`
    : 'run stopped on its deadline';
}

export function silenceStopReason(runDir) {
  const status = readJson(path.join(runDir, 'status.json'));
  if (status?.stopped_by_silence !== true) return null;
  const silence = status.stop?.watchdog?.decision?.silence_ms;
  const threshold = status.stop?.watchdog?.threshold_ms;
  const elapsed = Number.isFinite(silence) ? ` after ${silence} ms` : '';
  const limit = Number.isFinite(threshold) ? ` (threshold ${threshold} ms)` : '';
  return `run stopped by the silence watchdog${elapsed} without session activity${limit}`;
}
