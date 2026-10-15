/**
 * The runner-owned record of how a run's Codex process stopped.
 * Plan_80 A2/A4: stop cause, activity and evidence availability are independent recorded
 * facts, written by the runner because Codex can write events.jsonl.
 */
import path from 'node:path';
import { readJsonFileSync } from '../json-file.mjs';
import { AGENTS } from '../write-meta.mjs';
import { readEvents } from '../meta/events.mjs';
import { readSessionActivity } from '../codex-session-log.mjs';

/** Keep the first observed cause separate from the eventual exit and pipe drain. */
export function createStopObservation() {
  let first;
  let exitCode = null;
  let exitSignal = null;
  const observe = (trigger, error) => {
    if (!first) {
      first = { trigger, stopped_at: new Date().toISOString(), process_error: error?.message ?? null };
    }
  };
  return {
    observe,
    exit(code, signal) {
      observe('exit');
      exitCode = code;
      exitSignal = signal;
    },
    snapshot(stdioDrained, elapsedMs) {
      // A settlement no trigger preceded still names its fields: absent keys would read as an
      // older contract, while null says "observed, nothing came first".
      return {
        ...(first ?? { trigger: null, stopped_at: null, process_error: null }),
        exit_code: exitCode,
        signal: exitSignal,
        stdio_drained: stdioDrained,
        elapsed_ms: elapsedMs,
      };
    },
  };
}

/** Observe the result once, before later accounting can see a different file. */
export function buildStopRecord(run, runDir, agent) {
  const cfg = AGENTS[agent];
  if (!cfg) throw new Error(`unknown agent: ${agent}`);
  let resultFile;
  let result;
  try {
    result = readJsonFileSync(path.join(runDir, cfg.result));
  } catch (error) {
    resultFile = error.code === 'ENOENT'
      ? { state: 'missing' }
      : error instanceof SyntaxError || error.cause instanceof SyntaxError
        ? { state: 'malformed' }
        : { state: 'unreadable', error: error.message };
  }
  if (!resultFile) resultFile = { state: Boolean(result) && cfg.filled(result) ? 'filled' : 'unfilled' };
  const threadId = readEvents(runDir).session_id;
  const session = readSessionActivity({
    threadId,
    startedAt: threadId ? readJsonFileSync(path.join(runDir, 'status.json')).started_at : undefined,
    referenceAt: run.stop?.stopped_at,
  });
  return { version: 1, ...run.stop, receipts: run.receipts, result_file: resultFile, session };
}
