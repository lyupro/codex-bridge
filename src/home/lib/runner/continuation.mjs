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
import { readEvents } from '../meta/events.mjs';
import { AGENTS } from '../agents.mjs';
import { threadFreshnessGap } from './thread-freshness.mjs';
import { automaticSuccessorOf, lastRunHints, sameRun } from './continuation-outcome.mjs';
export { readyGrantLines } from './continuation-outcome.mjs';
export { sameRun } from './continuation-outcome.mjs';

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
    return refuse('not-last', { lastRun: last || 'none', example: CONTINUATION_ORDER_INPUT.example,
      successor: automaticSuccessorOf(runsRootPath, continuation.run, last) });
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
    return refuse('not-last', { successor: automaticSuccessorOf(runsRootPath, grant.run, last) });
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
  if (meta.status === 'CAPACITY') {
    const previousDirectory = namedRunDirectory(runsRootPath, status?.retry_of);
    if (previousDirectory && readJson(path.join(previousDirectory, 'meta.json'))?.status === 'CAPACITY') {
      return refuse('capacity-repeated', {});
    }
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
  if (!last || !sameRun(runsRootPath, grant.run, last)) {
    return refuse('not-last', { successor: automaticSuccessorOf(runsRootPath, grant.run, last) });
  }
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
    // OW-078: frozen events cover older records whose meta.json has no turn failure fact.
    turnFailed: readEvents(runDir).turn_failed === true,
  });
  if (blockers.length) return refuse('not-eligible', { blockers });
  const gap = threadFreshnessGap({ meta, status, readSession });
  if (gap) return refuse(gap.violation, gap.values);
  return null;
}
