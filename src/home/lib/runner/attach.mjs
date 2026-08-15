/** Finds a live run for an order and waits for its verdict when a repeated launcher call attaches. */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFileSync } from '../json-file.mjs';
import { IDENTITY_DEAD, IDENTITY_FOREIGN, processAlive, processIdentity } from '../process-identity.mjs';
import { exitCodeFor, writeFailure, chainRuns } from '../write-meta.mjs';

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
 * Is this pid still running for this run? Unknown identity remains live so an attach does not
 * declare a worker dead merely because the identity probe was unavailable.
 */
export const alive = (pid, runDir, status = {}) => {
  const identity = processIdentity({ runDir, status: { ...status, pid } });
  return identity !== IDENTITY_DEAD && identity !== IDENTITY_FOREIGN;
};

/**
 * Blocks until the worker's reply exists, or until the worker is provably gone without one.
 *
 * Identity is settled once, before the loop: a recycled pid would otherwise keep this call waiting
 * for a reply nobody is going to write, and asking again every 500 ms would spawn the start-time
 * probe for the whole length of a 20-minute run. Inside the loop the question is only whether the
 * number is still busy, which signal 0 answers for free.
 */
export async function waitForReply(runDir, workerPid, status = {}) {
  const replyPath = path.join(runDir, 'reply.txt');
  if (!alive(workerPid, runDir, status)) {
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
 * that window would be refused and sent to the --continue gate instead of being answered. The
 * promise being kept here is that repeating the command is always safe, and a promise with a
 * window in it is not one. markAbandoned() closes dead runs with FAIL before the gate, so this
 * path only covers a live run that has not recorded a verdict yet.
 *
 * A repeat that arrives after the verdict is answered from disk rather than refused, for the same
 * reason. `--continue` is the one case that must not attach: it is the orchestrator saying it read
 * the previous reply and wants another pass.
 */
export async function attach({ runsRoot, repo, slug, taskHash, orderId, chain, isContinue, noWait } = {}) {
  if (isContinue) return null;
  const runs = chain || chainRuns(runsRoot, repo, slug, taskHash, orderId);
  const sameOrder = runs
    .map((run) => ({ run, status: readJsonFile(path.join(runsRoot, run, 'status.json')) }))
    .filter(({ status }) => status && String(status.order_id ?? '') === String(orderId ?? ''));

  // On 2026-08-15 plan42-run3 reused plan42-run2's order id and was handed run2's verdict.
  // Refuse only when both fingerprints are known so runs predating task_hash keep attaching.
  const owner = sameOrder.at(-1);
  const ownerHash = String(owner?.status.task_hash ?? '').trim().toLowerCase();
  const incomingHash = String(taskHash ?? '').trim().toLowerCase();
  if (ownerHash && incomingHash && ownerHash !== incomingHash) {
    const ownerDir = path.join(runsRoot, owner.run);
    console.log(
      `Order id collision: ${JSON.stringify(String(orderId ?? ''))} already belongs to run folder ${ownerDir} ` +
        `(slug ${owner.status.slug}, started_at ${owner.status.started_at}) with a different task. ` +
        'Pass a new --order-id, or pass --continue if this really is another pass of the same order.',
    );
    return 2;
  }

  // The run an order is currently about is its newest one, and the chain arrives oldest first.
  // Reading it from the end is the whole point: `--continue` adds a second run under the same
  // order, and while it was in flight a repeat used to be answered by the first run's reply.txt —
  // a stale verdict presented as this pass's answer. Found by the Plan_11-2 checklist, 2026-08-04.
  let candidate = null;
  for (let i = sameOrder.length - 1; i >= 0; i -= 1) {
    const entry = sameOrder[i];
    const dir = path.join(runsRoot, entry.run);
    if (fs.existsSync(path.join(dir, 'reply.txt'))) {
      announceSavedReply(dir, orderId, entry.status.started_at);
      console.log(fs.readFileSync(path.join(dir, 'reply.txt'), 'utf8').replace(/\s+$/, ''));
      return exitCodeFor(readJsonFile(path.join(dir, 'meta.json'))?.status);
    }
    if (alive(entry.status.pid, dir, entry.status)) {
      candidate = entry;
      break;
    }
  }
  if (!candidate) {
    if (!noWait) return null;
    console.log(`No run exists for order id ${JSON.stringify(String(orderId ?? ''))}; --no-wait never starts a new run.`);
    return 4;
  }

  const runDir = path.join(runsRoot, candidate.run);
  // On 2026-08-13 a killed waiting call became an invented FAIL over a run already finished OK.
  // A distinct call outcome lets the dispatcher inspect disk without mistaking pending for failure.
  if (noWait) {
    announcePending(runDir, orderId, candidate.status.started_at);
    return 4;
  }
  announceLiveAttach(runDir, orderId, candidate.status.started_at);
  const replyText = await waitForReply(runDir, candidate.status.pid, candidate.status);
  if (replyText !== null) {
    console.log(replyText);
    return exitCodeFor(readJsonFile(path.join(runDir, 'meta.json'))?.status);
  }

  // Preserve the existing outcome if a worker dies after this attach begins. Dead runs are
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
  const { reply } = writeFailure(runDir, candidate.status.agent, 'run worker process died without recording a verdict', [
    `Log: codex-bridge read ${runDir}`,
    'Any Codex changes remain in the tree — check them with git status',
  ]);
  console.log(reply);
  return 1;
}
