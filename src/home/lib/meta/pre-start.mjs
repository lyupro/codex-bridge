/**
 * Identifies runs that never started Codex and removes them from paid-run views.
 *
 * The explicit state is the durable contract for new guard refusals; the second branch keeps
 * folders written before this fix from poisoning the next launch. Do not infer this from
 * events.jsonl: retention.mjs deletes that transport file from old paid runs, while
 * meta.events_bytes is recorded at verdict time and survives cleanup. The Plan_23 incident
 * showed why confusing those cases would remove repeat protection from a run that spent quota.
 * The third branch (Plan_80 E18) keeps an automatic continuation child abandoned before Codex
 * started from remaining the chain end and blocking a manual resume: of its parent; the meta
 * fields are required because retention deletes events.jsonl/stderr.log, never meta.json.
 */

import fs from 'node:fs';
import path from 'node:path';

import { HEARTBEAT_FILE } from '../heartbeat.mjs';
import { readJson } from './paths.mjs';

export function automaticChildMarker(status) {
  if (status === null || typeof status !== 'object' || Array.isArray(status)) return false;
  const recovery = status.recovery;
  if (recovery === null || typeof recovery !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(recovery))) return false;
  const parent = recovery.parent;
  return recovery.automatic === true
    && recovery.attempt === 2
    && typeof parent === 'string' && parent.length > 0
    && !/[\\/]/.test(parent) && parent !== '.' && parent !== '..'
    && status.resumed_from === parent;
}

export function abortedPreStart(runDir) {
  const status = readJson(path.join(runDir, 'status.json'));
  if (status?.state === 'aborted_pre_start') return true;
  if (status?.state === 'failed') return metaShowsNoExecution(runDir);

  if (status?.state !== 'abandoned' || !automaticChildMarker(status)
    || fs.existsSync(path.join(runDir, 'events.jsonl'))
    || fs.existsSync(path.join(runDir, HEARTBEAT_FILE))) return false;
  return metaShowsNoExecution(runDir);
}

// One definition for both retroactive branches: these fields survive retention, transport files do not.
function metaShowsNoExecution(runDir) {
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
