/**
 * Identifies runs that never started Codex and removes them from paid-run views.
 *
 * The explicit state is the durable contract for new guard refusals; the second branch keeps
 * folders written before this fix from poisoning the next launch. Do not infer this from
 * events.jsonl: retention.mjs deletes that transport file from old paid runs, while
 * meta.events_bytes is recorded at verdict time and survives cleanup. The Plan_23 incident
 * showed why confusing those cases would remove repeat protection from a run that spent quota.
 */

import path from 'node:path';

import { readJson } from './paths.mjs';

export function abortedPreStart(runDir) {
  const status = readJson(path.join(runDir, 'status.json'));
  if (status?.state === 'aborted_pre_start') return true;
  if (status?.state !== 'failed') return false;

  const meta = readJson(path.join(runDir, 'meta.json'));
  return meta?.exit === null
    && meta?.session_id == null
    && meta?.events_bytes === 0
    && meta?.stderr_bytes === 0
    && meta?.tokens_reported !== true;
}

export function startedRuns(runsRoot, runs) {
  return runs.filter((run) => !abortedPreStart(path.join(runsRoot, run)));
}
