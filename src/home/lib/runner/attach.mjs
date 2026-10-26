/** Finds a live run for an order and waits for its verdict when a repeated launcher call attaches. */
import { EXIT } from './exit-codes.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFileSync } from '../json-file.mjs';
import { workerMayBeAlive } from '../meta/run-liveness.mjs';
import { automaticChildMarker, startedRuns } from '../meta/pre-start.mjs';
import { recoverySuccessor } from '../meta/recovery-successor.mjs';
import { processAlive } from '../process-identity.mjs';
import { exitCodeFor, writeFailure, chainRuns } from '../write-meta.mjs';
import { readyGrantLines, sameRun } from './continuation.mjs';
import { conflictingOrderOwner, orderOwnerConflictText, runsForOrder } from './order-owner.mjs';

// The attach call is the only process that waits for a worker it did not spawn. Keeping that
// wait here leaves the launcher free to return before a caller's time ceiling kills it.
const POLL_MS = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The 2026-08-10_220535_plan25-2-install-table-two-roots incident showed that ATTACH alone
// can be mistaken for this pass. Distinguish a saved answer from a live run whose verdict is
// still pending so provenance is truthful while preserving the guarantee that no work restarted.
function announceSavedReply(runDir, orderId, startedAt) {
  console.log(`ATTACH=${runDir} order-id=${orderId} started=${startedAt}`);
  console.log(`This is the answer of the previous run started at ${startedAt}; no new work was started.`);
}

function announceLiveAttach(runDir, orderId, startedAt) {
  console.log(`ATTACH=${runDir} order-id=${orderId} started=${startedAt}`);
  console.log(
    `Attached to the run already in progress since ${startedAt}; no new work was started, and this invocation is waiting for its verdict.`,
  );
}

function elapsedSince(startedAt) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  if (!Number.isFinite(elapsedSeconds)) return 'unknown';
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function announcePending(runDir, orderId, startedAt) {
  console.log(`ATTACH=${runDir} order-id=${orderId} started=${startedAt}`);
  console.log(
    `Run is still in progress; elapsed ${elapsedSince(startedAt)}. Repeat the same command without --no-wait later to wait for its verdict.`,
  );
}

export const readJsonFile = (file) => {
  try {
    return readJsonFileSync(file);
  } catch {
    return null;
  }
};

/**
 * Blocks until the worker's reply exists, or until the worker is provably gone without one.
 *
 * Identity is settled once, before the loop: a recycled pid would otherwise keep this call waiting
 * for a reply nobody is going to write, and asking again every 500 ms would spawn the start-time
 * probe for the whole length of a 20-minute run. Inside the loop the question is only whether the
 * number is still busy, which signal 0 answers for free.
 */
export async function waitForReply(runDir, workerPid, status) {
  const replyPath = path.join(runDir, 'reply.txt');
  if (!workerMayBeAlive({ runDir, status })) {
    return fs.existsSync(replyPath) ? fs.readFileSync(replyPath, 'utf8').replace(/\s+$/, '') : null;
  }
  let pollsSinceDeath = 0;
  for (;;) {
    if (fs.existsSync(replyPath)) return fs.readFileSync(replyPath, 'utf8').replace(/\s+$/, '');
    // A dead worker will never write it. Two extra polls before believing that: the pid is
    // released around the same moment as the last write, and the order is not guaranteed.
    if (processAlive(workerPid)) {
      pollsSinceDeath = 0;
    } else {
      pollsSinceDeath += 1;
      if (pollsSinceDeath > 2) return null;
    }
    await sleep(POLL_MS);
  }
}

/**
 * Attach to the run this order already has, returning null when this call must start one.
 *
 * What counts as "not finished yet" is the absence of reply.txt, not the absence of meta.json.
 * The artifact order is meta.json first, reply.txt last, so between the two there is a moment
 * where the verdict exists and the run is not closed — judged by meta.json, a repeat arriving in
 * that window would be refused and sent to the continuation gate instead of being answered. The
 * promise being kept here is that repeating the command is always safe, and a promise with a
 * window in it is not one. markAbandoned() closes dead runs with FAIL before the gate, so this
 * path only covers a live run that has not recorded a verdict yet.
 *
 * A repeat that arrives after the verdict is answered from disk rather than refused, for the same
 * reason. A `continue:` grant may attach to a run created from it: the 2026-09-23 dispatcher
 * incident showed that repeating the identical continuation command must return to that run.
 */
export async function attach({
  runsRoot, repo, slug, taskHash, orderId, chain, grantRun, retryRun, resumeRun, isContinue, noWait, beforeWait,
} = {}) {
  const runs = chain || chainRuns(runsRoot, repo, slug, taskHash, orderId);
  const started = startedRuns(runsRoot, runs);
  const runRecords = runs
    .map((run) => ({ run, status: readJsonFile(path.join(runsRoot, run, 'status.json')) }))
    .filter(({ status }) => status);
  const sameOrder = runsForOrder(runRecords, orderId);
  // Plan_80 E18: automatic ancestry is not a consumed manual grant; choose its anchor first.
  const anchors = sameOrder.filter(({ status }) => !automaticChildMarker(status));
  const attachRuns = isContinue
    ? anchors.filter(({ status }) => retryRun
      ? status.retry_of && sameRun(runsRoot, status.retry_of, retryRun)
      : resumeRun
        ? status.resumed_from && sameRun(runsRoot, status.resumed_from, resumeRun)
        : grantRun && status.continued_from && sameRun(runsRoot, status.continued_from, grantRun))
    : anchors;
  if (isContinue && !attachRuns.length) return null;

  const owner = isContinue ? null : conflictingOrderOwner(runRecords, orderId, taskHash);
  if (owner) {
    const ownerDir = path.join(runsRoot, owner.run);
    console.log(orderOwnerConflictText(owner, ownerDir, orderId));
    return EXIT.USAGE;
  }

  // The run an order is currently about is its newest one, and the chain arrives oldest first.
  // Reading it from the end is the whole point: a continuation adds a second run under the same
  // order, and while it was in flight a repeat used to be answered by the first run's reply.txt —
  // a stale verdict presented as this pass's answer. Found by the Plan_11-2 checklist, 2026-08-04.
  let candidate = null;
  for (let i = attachRuns.length - 1; i >= 0; i -= 1) {
    const entry = attachRuns[i];
    const dir = path.join(runsRoot, entry.run);
    if (fs.existsSync(path.join(dir, 'reply.txt'))) {
      candidate = entry;
      break;
    }
    if (workerMayBeAlive({ runDir: dir, status: entry.status })) {
      candidate = entry;
      break;
    }
  }
  if (!candidate) {
    if (!noWait) return null;
    console.log(`No run exists for order id ${JSON.stringify(String(orderId ?? ''))}; --no-wait never starts a new run.`);
    return EXIT.PENDING;
  }

  let releasedBeforeWait = false;
  return answerRun(candidate, true);

  async function answerRun(entry, followSuccessor) {
    const runDir = path.join(runsRoot, entry.run);
    const replyPath = path.join(runDir, 'reply.txt');
    if (fs.existsSync(replyPath)) {
      announceSavedReply(runDir, orderId, entry.status.started_at);
      console.log(fs.readFileSync(replyPath, 'utf8').replace(/\s+$/, ''));
      return afterReply(entry, followSuccessor, true);
    }
    // A successor can already be dead when the anchor's saved answer is read.
    if (!followSuccessor && !workerMayBeAlive({ runDir, status: entry.status })) {
      return answerDeath(entry, runDir);
    }
    // On 2026-08-13 a killed waiting call became an invented FAIL over a run already finished OK.
    // A distinct call outcome lets the dispatcher inspect disk without mistaking pending for failure.
    if (noWait) {
      announcePending(runDir, orderId, entry.status.started_at);
      return EXIT.PENDING;
    }
    if (!releasedBeforeWait) {
      releasedBeforeWait = true;
      await beforeWait?.();
    }
    announceLiveAttach(runDir, orderId, entry.status.started_at);
    const replyText = await waitForReply(runDir, entry.status.pid, entry.status);
    if (replyText !== null) {
      console.log(replyText);
      return afterReply(entry, followSuccessor, false);
    }
    return answerDeath(entry, runDir);
  }

  function afterReply(entry, followSuccessor, cached) {
    const runDir = path.join(runsRoot, entry.run);
    const meta = readJsonFile(path.join(runDir, 'meta.json'));
    const code = exitCodeFor(meta?.status);
    if (followSuccessor) {
      // Plan_80 E18: the worker publishes the pointer before reply.txt, possibly during our wait.
      const successor = recoverySuccessor(runsRoot, entry.run);
      if (successor.state === 'invalid') {
        console.log(`Automatic continuation record of ${runDir} is unusable (${successor.reason}); the verdict above is final.`);
      } else if (successor.state === 'valid' && !successor.started) {
        console.log(`Automatic continuation ${successor.childDir} never started Codex; the verdict above is final.`);
      } else if (successor.state === 'valid') {
        console.log(`CONTINUED=${successor.childDir} from=${entry.run}`);
        console.log("The run above stopped and was continued automatically in the same Codex thread; the verdict below is the continuation's.");
        return answerRun({
          run: successor.child, status: readJsonFile(path.join(successor.childDir, 'status.json')),
        }, false);
      }
    }
    // Plan_80 E18: a never-started child must not hide its parent's cached-failure repair.
    if (cached && meta?.status !== 'OK' && entry.run === started.at(-1)) {
      console.log(readyGrantLines(runsRoot, started));
    }
    return code;
  }

  function answerDeath(entry, runDir) {
    // Preserve the existing outcome if a worker dies after this attach begins. Dead anchors are
    // excluded above; assigning an abandoned verdict is pass 2 of Plan_11 and remains separate.
    const meta = readJsonFile(path.join(runDir, 'meta.json'));
    if (meta) {
      console.log(
        [
          `${meta.status} — ${meta.reason || 'verdict recorded, worker process response not saved'}`,
          `Run: ${runDir}`,
        ].join('\n'),
      );
      return exitCodeFor(meta.status);
    }
    const { reply } = writeFailure(runDir, entry.status.agent, 'run worker process died without recording a verdict', {
      action: 'fail-no-result', extraLines: [
        `Log: codex-bridge read ${runDir}`,
        'Any Codex changes remain in the tree — check them with git status',
      ],
    });
    console.log(reply);
    return EXIT.FAIL;
  }
}
