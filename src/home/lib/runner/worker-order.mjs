/**
 * The order the launcher leaves for the worker: worker.json in the run folder.
 *
 * After the launcher/worker split this file is the only connection between the two halves, and the
 * worker never re-reads the CLI or the configuration — a run that consulted config.json twice could
 * end up honouring two different limits. It carries `agent`, `slug`, `order_id`, `repo`,
 * `is_git_repo`, `launcher_pid`, `budget_minutes`, `scope_new`, `profile` and `args`; worker.mjs
 * reads `repo`, `agent`, `args`, `is_git_repo` and `budget_minutes`. The rest is deliberate: those
 * fields are what a run folder read back months later needs in order to explain itself — which
 * order it belonged to, which new paths it declared included, and which worker was actually
 * ordered. Nothing may be dropped from this shape without changing worker.mjs and saying so out
 * loud; `docs/worker-contract.md` is the document that says it.
 *
 * It lives beside launcher.mjs rather than inside it because writing this contract is its own job,
 * and the launcher had grown past the size limit while the contract was buried in the middle of it.
 */
import fs from 'node:fs';
import path from 'node:path';

export function workerOrder({
  agent,
  slug,
  orderId,
  repo,
  isGitRepo,
  launcherPid,
  budgetMinutes,
  scopeNew,
  profile,
  args,
}) {
  return {
    agent,
    slug,
    order_id: orderId,
    repo,
    is_git_repo: isGitRepo,
    launcher_pid: launcherPid,
    // The mode's wall-clock budget, resolved by the launcher and never re-read by the worker.
    budget_minutes: budgetMinutes,
    scope_new: scopeNew,
    // Which worker was ordered, and where each half of that answer came from. Recorded separately
    // from args because an absent flag says nothing: a run without `-m` looked exactly like a run
    // whose configured model had never been read, which is how a pinned profile went unnoticed for
    // three releases (2026-08-26).
    profile,
    args,
  };
}

export function writeWorkerOrder(runDir, fields) {
  fs.writeFileSync(
    path.join(runDir, 'worker.json'),
    `${JSON.stringify(workerOrder(fields), null, 2)}\n`,
  );
}
