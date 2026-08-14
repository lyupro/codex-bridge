/**
 * Owns the zero-quota decision about whether a requested continuation was ordered.
 *
 * The 2026-08-05 incident showed why the runner must not infer a second pass from a verdict:
 * only the orchestrator read that verdict and can name the run and reason it is willing to fund.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONTINUATION_INPUT, parseContinuationGrant } from '../required-inputs.mjs';
import { readJson } from '../write-meta.mjs';

const sameRun = (runsRootPath, left, right) => {
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
  if (typeof grant === 'string') return parseContinuationGrant(grant);
  if (!grant || typeof grant !== 'object') return null;
  const run = String(grant.run ?? '').trim();
  const reason = String(grant.reason ?? '').trim();
  return run && reason ? { run, reason } : null;
}

const grantExample = `Example: \`continue: ${CONTINUATION_INPUT.example}\`.`;
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
  return { run, status: outcomeStatus, reason: outcomeReason };
}

function lastRunHints(runsRootPath, chain, grantReason) {
  const last = lastRunOutcome(runsRootPath, chain);
  if (!last) {
    return 'Last run: none. Outcome: none. Ready grant line: none (there is no run to continue).';
  }
  const reason = String(grantReason ?? last.reason).trim() || last.reason;
  return `Last run: ${last.run}. Outcome: ${last.status} — ${last.reason}. ` +
    `Ready grant line: continue: ${last.run} — ${reason}.`;
}

/**
 * Applies the one-continuation limit and all continuation safety gates before a folder is created.
 *
 * The limit is counted over the runs carrying THIS order id, not over the whole chain. The chain
 * also ties runs together by slug and by the fingerprint of the task text, which is what catches a
 * repeat that renamed itself — but counting continuations that way makes the escape hatch
 * unreachable: the operator's rule is "more passes than one need a new order id", and a new order
 * id lands in the same chain through the task hash. A task would then be refused with --continue
 * for having spent its continuation and refused without it for already having runs — permanently
 * unrunnable, which is a worse failure than the retry storm this limit exists to stop.
 */
export function continuationRefusal(runsRootPath, chain, isContinue, orderId, grant) {
  const continuation = normalizeGrant(grant);
  if (!isContinue) {
    if (!continuation) return null;
    return (
      '--continue is required when the task text contains a `continue:` grant. ' +
      `${lastRunHints(runsRootPath, chain, continuation.reason)} ` +
      'The submitted grant was not rewritten. The run folder was not created; quota was not spent.'
    );
  }

  if (!continuation) {
    return (
      '--continue is refused: the orchestrator did not provide a `continue:` grant in the task text. ' +
      `${grantExample} ${grantAction} The run folder was not created; quota was not spent.`
    );
  }

  const namedDirectory = namedRunDirectory(runsRootPath, continuation.run);
  if (!namedDirectory) {
    return (
      `--continue is refused: the orchestrator named run “${continuation.run}”, but it does not ` +
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
      `--continue is refused: grant ${continuation.run} is not the LAST run of this task's chain; ` +
      `the current last run is ${last || 'none'}. A continuation is single-use: continuing the ` +
      'last run appends a later run, so the old grant stops matching by itself — no counter or new ' +
      `state is used. ${grantExample} ${grantAction} The run folder was not created; quota was not spent.`
    );
  }

  const wanted = String(orderId ?? '').trim();
  const ofThisOrder = chain.filter(
    (run) => String(readJson(path.join(runsRootPath, run, 'status.json'))?.order_id ?? '').trim() === wanted,
  );
  if (ofThisOrder.length === 0) return null;
  if (ofThisOrder.length > 1) {
    const spent = ofThisOrder.map((run) => path.join(runsRootPath, run)).join(', ');
    return (
      `--continue is refused: order “${wanted}” already spent its allowed continuation on ${spent}. ` +
      'A further pass needs a new order id from the orchestrator. The run folder was not ' +
      'created; quota was not spent.'
    );
  }
  const previous = path.join(runsRootPath, ofThisOrder[0]);
  const status = readJson(path.join(previous, 'status.json'));
  const meta = readJson(path.join(previous, 'meta.json'));
  if (!meta?.status || status?.state === 'running') {
    return (
      `--continue is refused: previous run ${previous} has no finished verdict and may still ` +
      'be editing the worktree. Repeat without --continue to attach to it. The run folder was ' +
      'not created; quota was not spent.'
    );
  }
  return null;
}
