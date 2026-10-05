/**
 * Owns the zero-quota decision about whether a requested continuation was ordered.
 *
 * The 2026-08-05 incident showed why the runner must not infer a second pass from a verdict:
 * only the orchestrator read that verdict and can name the run and reason it is willing to fund.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONTINUATION_ORDER_INPUT, orderInputName } from '../order-schema.mjs';
import { readJson } from '../write-meta.mjs';
import { workerMayBeAlive } from '../meta/run-liveness.mjs';

// One comparison of run names for the grant gate and for attach, so a repeat and a grant can never
// disagree about whether two spellings name the same folder.
export const sameRun = (runsRootPath, left, right) => {
  const a = path.resolve(runsRootPath, left);
  const b = path.resolve(runsRootPath, right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

function namedRunDirectory(runsRootPath, run) {
  if (!run || run === '.' || run === '..' || path.basename(run) !== run) return null;
  const directory = path.join(runsRootPath, run);
  try {
    return fs.statSync(directory).isDirectory() ? directory : null;
  } catch {
    return null;
  }
}

function normalizeGrant(grant) {
  if (!grant || typeof grant !== 'object') return null;
  const run = String(grant.run ?? '').trim();
  const reason = String(grant.reason ?? '').trim();
  return run && reason ? { run, reason } : null;
}

const grantExample = `Example: \`continue: ${CONTINUATION_ORDER_INPUT.example}\`.`;
const grantAction =
  'Action: ask the orchestrator for an explicit grant naming the run and reason; do not invent or reuse a continuation.';

// The 2026-08-10_220535_plan25-2-install-table-two-roots incident showed that a refusal must
// carry the repair line; otherwise a typo forces an unnecessary directory listing and retry.
function lastRunOutcome(runsRootPath, chain) {
  const run = chain[chain.length - 1];
  if (!run) return null;
  const status = readJson(path.join(runsRootPath, run, 'status.json')) || {};
  const meta = readJson(path.join(runsRootPath, run, 'meta.json')) || {};
  const outcomeStatus = String(meta.status ?? status.status ?? status.state ?? 'unknown').trim() || 'unknown';
  const outcomeReason = String(meta.reason ?? status.reason ?? 'reason not recorded').trim() || 'reason not recorded';
  return { run, status: outcomeStatus, reason: outcomeReason, verdict: meta.status, orderId: status.order_id };
}

export function readyGrantLines(runsRootPath, chain, grantReason) {
  const last = lastRunOutcome(runsRootPath, chain);
  if (!last) return 'Ready grant line: none (there is no run to continue).';
  const reason = String(grantReason ?? last.reason).trim() || last.reason;
  const continuation = `Ready grant line: continue: ${last.run} — ${reason}.`;
  // Plan_75 D1: the TradeForge failed advise spent its continuation, so show the same-pass repair.
  // A run without order_id cannot be retried (retryRefusal step d), so it gets no retry line.
  const orderId = String(last.orderId ?? '').trim();
  if (!last.verdict || last.verdict === 'OK' || !orderId) return continuation;
  return continuation +
    ` Ready retry line: retry: ${last.run} — ${last.reason} (repeats that pass under order ${orderId}).`;
}

function lastRunHints(runsRootPath, chain, grantReason) {
  const last = lastRunOutcome(runsRootPath, chain);
  if (!last) {
    return 'Last run: none. Outcome: none. Ready grant line: none (there is no run to continue).';
  }
  return `Last run: ${last.run}. Outcome: ${last.status} — ${last.reason}. ` +
    readyGrantLines(runsRootPath, chain, grantReason);
}

/**
 * Applies the one-continuation limit and all continuation safety gates before a folder is created.
 *
 * The limit is counted over the runs carrying THIS order id, not over the whole chain. The chain
 * also ties runs together by slug and by the fingerprint of the task text, which is what catches a
 * repeat that renamed itself — but counting continuations that way makes the escape hatch
 * unreachable: the operator's rule is "more passes than one need a new order id", and a new order
 * id lands in the same chain through the task hash. A task would then be refused with a grant
 * for having spent its continuation and refused without one for already having runs — permanently
 * unrunnable, which is a worse failure than the retry storm this limit exists to stop.
 */
export function continuationRefusal(runsRootPath, chain, isContinue, orderId, grant) {
  const continuation = normalizeGrant(grant);
  // Plan_63 D9: only header grant objects authorize a pass; a string is no grant.
  if (!isContinue || !continuation) return null;

  const namedDirectory = namedRunDirectory(runsRootPath, continuation.run);
  if (!namedDirectory) {
    return (
      `${orderInputName('continue')} is refused: the orchestrator named run “${continuation.run}”, but it does not ` +
      `exist as a run folder in this project's runs directory ${runsRootPath}. ` +
      `${lastRunHints(runsRootPath, chain, continuation.reason)} ` +
      `${grantExample} ${grantAction} The submitted grant was not rewritten. ` +
      'The run folder was not created; quota was not spent.'
    );
  }

  const last = chain[chain.length - 1];
  // Continuing the last run appends a later run, so the old grant stops matching by itself; this
  // incident needs no counter or new state to make an orchestrator grant single-use.
  if (!last || !sameRun(runsRootPath, continuation.run, last)) {
    return (
      `${orderInputName('continue')} is refused: grant ${continuation.run} is not the LAST run of this task's chain; ` +
      `the current last run is ${last || 'none'}. A continuation is single-use: continuing the ` +
      'last run appends a later run, so the old grant stops matching by itself — no counter or new ' +
      `state is used. ${lastRunHints(runsRootPath, chain, continuation.reason)} ` +
      `${grantExample} ${grantAction} The run folder was not created; quota was not spent.`
    );
  }

  const wanted = String(orderId ?? '').trim();
  // Plan_75 D1, TradeForge capacity incident: a retry spends no new pass, even after an OK verdict.
  const ofThisOrder = chain.filter((run) => {
    const status = readJson(path.join(runsRootPath, run, 'status.json'));
    return String(status?.order_id ?? '').trim() === wanted && !String(status?.retry_of ?? '').trim();
  });
  if (ofThisOrder.length === 0) return null;
  if (ofThisOrder.length > 1) {
    const spent = ofThisOrder.map((run) => path.join(runsRootPath, run)).join(', ');
    return (
      `${orderInputName('continue')} is refused: order “${wanted}” already spent its allowed continuation on ${spent}. ` +
      `${lastRunHints(runsRootPath, chain, continuation.reason)} ` +
      'A further pass needs a new order id from the orchestrator. The run folder was not ' +
      'created; quota was not spent.'
    );
  }
  const previous = path.join(runsRootPath, ofThisOrder[0]);
  const status = readJson(path.join(previous, 'status.json'));
  const meta = readJson(path.join(previous, 'meta.json'));
  if (!meta?.status || status?.state === 'running') {
    return (
      `${orderInputName('continue')} is refused: previous run ${previous} has no finished verdict and may still ` +
      `be editing the worktree. Repeat without ${orderInputName('continue')} to attach to it. ` +
      `${lastRunHints(runsRootPath, chain, continuation.reason)} The run folder was ` +
      'not created; quota was not spent.'
    );
  }
  return null;
}

export function retryRefusal(runsRootPath, chain, isContinue, orderId, grant, liveness = workerMayBeAlive) {
  const refuse = (message) => `${message} The run folder was not created; quota was not spent.`;
  const runDir = namedRunDirectory(runsRootPath, grant?.run);
  if (!runDir) {
    return refuse(`Retry is refused: ${grant?.run || 'none'} is not a bare existing run folder in ${runsRootPath}.`);
  }
  const last = chain[chain.length - 1];
  // Plan_75 D1: appending the TradeForge retry makes this grant single-use without a new counter.
  if (!last || !sameRun(runsRootPath, grant.run, last)) {
    return refuse(`Retry is refused: grant ${grant.run} is not the LAST run of this task's chain; a retry is single-use.`);
  }
  const status = readJson(path.join(runDir, 'status.json'));
  const wanted = String(orderId ?? '').trim();
  const previousOrder = String(status?.order_id ?? '').trim();
  if (!previousOrder || previousOrder !== wanted) {
    return refuse(`Retry is refused: run ${grant.run} order_id ${previousOrder || '(missing)'} differs from order ${wanted}. ` +
      'A retry repeats its own order; a run without order_id predates orders — start a new order.');
  }
  const meta = readJson(path.join(runDir, 'meta.json'));
  // Plan_75 D1: a verdict alone must not let a retry overlap the failed advise's live writer.
  if (!meta?.status || liveness({ runDir, status })) {
    return refuse(`Retry is refused: run ${grant.run} has no finished verdict or its worker may still be alive and writing. ` +
      `Repeat without ${orderInputName('retry')} to attach to it.`);
  }
  if (meta.status === 'OK') {
    return refuse(`Retry is refused: run ${grant.run} ended OK. A retry repeats a failed pass; use continue: for the next pass.`);
  }
  return null;
}
