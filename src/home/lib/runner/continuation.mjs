/**
 * Owns the zero-quota decision about whether a requested continuation was ordered.
 *
 * The 2026-08-05 incident showed why the runner must not infer a second pass from a verdict:
 * only the orchestrator read that verdict and can name the run and reason it is willing to fund.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONTINUATION_ORDER_INPUT, orderInputName } from '../order-schema.mjs';
import { orderRuleMessage } from '../order-rules.mjs';
import { orderDiagnosticMessage } from '../order-diagnostics.mjs';
import { readJson } from '../write-meta.mjs';
import { workerMayBeAlive } from '../meta/run-liveness.mjs';
import { readSessionActivity } from '../codex-session-log.mjs';
import { grantBlockers } from '../meta/stop-assessment.mjs';
import { AGENTS } from '../agents.mjs';
import { threadFreshnessGap } from './thread-freshness.mjs';

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
  if (!last) return orderRuleMessage('ready-grant-line', { variant: 'none' });
  const reason = String(grantReason ?? last.reason).trim() || last.reason;
  const continuation = orderRuleMessage('ready-grant-line', { variant: 'continue', run: last.run, reason });
  // Plan_75 D1: the TradeForge failed advise spent its continuation, so show the same-pass repair.
  // A run without order_id cannot be retried (retryRefusal step d), so it gets no retry line.
  const orderId = String(last.orderId ?? '').trim();
  if (!last.verdict || last.verdict === 'OK' || !orderId) return continuation;
  return [continuation, orderRuleMessage('ready-grant-line', {
    variant: 'retry', run: last.run, reason: last.reason, orderId,
  })].join(' ');
}

function lastRunHints(runsRootPath, chain, grantReason) {
  const last = lastRunOutcome(runsRootPath, chain);
  if (!last) {
    return [orderRuleMessage('grant-last-run-hint', { variant: 'none' }),
      orderRuleMessage('ready-grant-line', { variant: 'none' })].join(' ');
  }
  return [orderRuleMessage('grant-last-run-hint', {
    variant: 'last', run: last.run, status: last.status, reason: last.reason,
  }), readyGrantLines(runsRootPath, chain, grantReason)].join(' ');
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

  const refuse = (violation, values) => [orderRuleMessage('continuation-grant-usable', {
    violation, labelName: orderInputName('continue'), run: continuation.run,
    hints: lastRunHints(runsRootPath, chain, continuation.reason), ...values,
  }), orderDiagnosticMessage('run-not-created')].join(' ');

  const namedDirectory = namedRunDirectory(runsRootPath, continuation.run);
  if (!namedDirectory) {
    return refuse('missing-folder', { runsRoot: runsRootPath, example: CONTINUATION_ORDER_INPUT.example });
  }

  const last = chain[chain.length - 1];
  // Continuing the last run appends a later run, so the old grant stops matching by itself; this
  // incident needs no counter or new state to make an orchestrator grant single-use.
  if (!last || !sameRun(runsRootPath, continuation.run, last)) {
    return refuse('not-last', { lastRun: last || 'none', example: CONTINUATION_ORDER_INPUT.example });
  }

  const wanted = String(orderId ?? '').trim();
  // Plan_75 D1 / Plan_80 E13 O5: retries and resumes spend no new pass, even after an OK verdict.
  const ofThisOrder = chain.filter((run) => {
    const status = readJson(path.join(runsRootPath, run, 'status.json'));
    return String(status?.order_id ?? '').trim() === wanted && !String(status?.retry_of ?? '').trim() &&
      !String(status?.resumed_from ?? '').trim();
  });
  if (ofThisOrder.length === 0) return null;
  if (ofThisOrder.length > 1) {
    const spent = ofThisOrder.map((run) => path.join(runsRootPath, run)).join(', ');
    return refuse('spent', { orderId: wanted, spent });
  }
  const previous = path.join(runsRootPath, ofThisOrder[0]);
  const status = readJson(path.join(previous, 'status.json'));
  const meta = readJson(path.join(previous, 'meta.json'));
  if (!meta?.status || status?.state === 'running') {
    return refuse('unfinished', { previous });
  }
  return null;
}

export function retryRefusal(runsRootPath, chain, isContinue, orderId, grant, liveness = workerMayBeAlive) {
  const refuse = (violation, values) => [orderRuleMessage('retry-grant-usable', {
    violation, run: grant?.run || 'none', ...values,
  }), orderDiagnosticMessage('run-not-created')].join(' ');
  const runDir = namedRunDirectory(runsRootPath, grant?.run);
  if (!runDir) {
    return refuse('missing-folder', { runsRoot: runsRootPath });
  }
  const last = chain[chain.length - 1];
  // Plan_75 D1: appending the TradeForge retry makes this grant single-use without a new counter.
  if (!last || !sameRun(runsRootPath, grant.run, last)) {
    return refuse('not-last', {});
  }
  const status = readJson(path.join(runDir, 'status.json'));
  const wanted = String(orderId ?? '').trim();
  const previousOrder = String(status?.order_id ?? '').trim();
  if (!previousOrder || previousOrder !== wanted) {
    return refuse('order-mismatch', { previousOrder: previousOrder || '(missing)', orderId: wanted });
  }
  const meta = readJson(path.join(runDir, 'meta.json'));
  // Plan_75 D1: a verdict alone must not let a retry overlap the failed advise's live writer.
  if (!meta?.status || liveness({ runDir, status })) {
    return refuse('unfinished', { labelName: orderInputName('retry') });
  }
  if (meta.status === 'OK') {
    return refuse('ended-ok', {});
  }
  return null;
}

export function resumeRefusal(runsRootPath, chain, orderId, grant, {
  agent, phase, liveness = workerMayBeAlive, readSession = readSessionActivity,
}) {
  const refuse = (violation, values) => [orderRuleMessage('resume-grant-usable', {
    violation, run: grant?.run || 'none', ...values,
  }), orderDiagnosticMessage('run-not-created')].join(' ');
  const runDir = namedRunDirectory(runsRootPath, grant?.run);
  if (!runDir) return refuse('missing-folder', { runsRoot: runsRootPath });
  const last = chain[chain.length - 1];
  if (!last || !sameRun(runsRootPath, grant.run, last)) return refuse('not-last', {});
  const status = readJson(path.join(runDir, 'status.json'));
  const wanted = String(orderId ?? '').trim();
  const previousOrder = String(status?.order_id ?? '').trim();
  if (!previousOrder || previousOrder !== wanted) {
    return refuse('order-mismatch', { previousOrder: previousOrder || '(missing)', orderId: wanted });
  }
  const phaseOf = (value) => String(value ?? '').trim() || 'default';
  const previousPhase = phaseOf(status.phase);
  if (status.agent !== agent || previousPhase !== phaseOf(phase)) {
    return [orderRuleMessage('resume-pass-identity', { agent: status.agent, phase: previousPhase }),
      orderDiagnosticMessage('run-not-created')].join(' ');
  }
  const meta = readJson(path.join(runDir, 'meta.json'));
  if (!meta?.status || liveness({ runDir, status })) {
    return refuse('unfinished', { labelName: orderInputName('resume') });
  }
  if (meta.status === 'OK') return refuse('ended-ok', {});
  // Plan_80 E13 O5: a cached eligibility claim cannot authorize resuming a writer or a legacy run.
  const blockers = grantBlockers({
    status: meta.status, resultOk: meta.result_ok === true, agentWrites: AGENTS[agent].writes,
    threadId: meta.session_id, stop: meta.stop,
  });
  if (blockers.length) return refuse('not-eligible', { blockers });
  const gap = threadFreshnessGap({ meta, status, readSession });
  if (gap) return refuse(gap.violation, gap.values);
  return null;
}
