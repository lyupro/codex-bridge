/** Finds a live run for an order and waits for its verdict when a repeated launcher call attaches. */
import fs from 'node:fs';
import path from 'node:path';
import { exitCodeFor, writeFailure, chainRuns } from '../write-meta.mjs';

// The attach call is the only process that waits for a worker it did not spawn. Keeping that
// wait here leaves the launcher free to return before a caller's time ceiling kills it.
const POLL_MS = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const readJsonFile = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Is this pid still running? EPERM means the process exists and belongs to someone else,
 * which for our purposes is alive. Same reading write-meta.mjs uses — two answers to "is
 * this run still going" would be one answer too many.
 */
export const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** Blocks until the worker's reply exists, or until the worker is provably gone without one. */
export async function waitForReply(runDir, workerPid) {
  const replyPath = path.join(runDir, 'reply.txt');
  let pollsSinceDeath = 0;
  for (;;) {
    if (fs.existsSync(replyPath)) return fs.readFileSync(replyPath, 'utf8').replace(/\s+$/, '');
    // A dead worker will never write it. Two extra polls before believing that: the pid is
    // released around the same moment as the last write, and the order is not guaranteed.
    if (alive(workerPid)) {
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
 * window in it is not one.
 *
 * A repeat that arrives after the verdict is answered from disk rather than refused, for the same
 * reason. `--continue` is the one case that must not attach: it is the orchestrator saying it read
 * the previous reply and wants another pass.
 */
export async function attach({ runsRoot, repo, slug, taskHash, orderId, chain, isContinue } = {}) {
  if (isContinue) return null;
  const runs = chain || chainRuns(runsRoot, repo, slug, taskHash, orderId);
  const sameOrder = runs
    .map((run) => ({ run, status: readJsonFile(path.join(runsRoot, run, 'status.json')) }))
    .filter(({ status }) => status && String(status.order_id ?? '') === String(orderId ?? ''));

  const answered = sameOrder.find(({ run }) => fs.existsSync(path.join(runsRoot, run, 'reply.txt')));
  if (answered) {
    const runDir = path.join(runsRoot, answered.run);
    console.log(`ATTACH=${runDir} started=${answered.status.started_at}`);
    console.log(fs.readFileSync(path.join(runDir, 'reply.txt'), 'utf8').replace(/\s+$/, ''));
    return exitCodeFor(readJsonFile(path.join(runDir, 'meta.json'))?.status);
  }

  const candidate = sameOrder.find(({ status }) => alive(status.pid));
  if (!candidate) return null;

  const runDir = path.join(runsRoot, candidate.run);
  console.log(`ATTACH=${runDir} started=${candidate.status.started_at}`);
  const replyText = await waitForReply(runDir, candidate.status.pid);
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
    `Log: ${path.join(runDir, 'raw.log')}`,
    'Any Codex changes remain in the tree — check them with git status',
  ]);
  console.log(reply);
  return 1;
}
