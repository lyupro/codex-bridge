/**
 * The half the caller can kill: every preparation and every refusal that costs no quota,
 * then the spawn of the worker and the immediate return; a repeated call waits for the reply.
 *
 * The order it leaves for the worker is worker.json in the run folder — after the split that file
 * is the only connection between the two halves. Its shape and the reason for every field live in
 * worker-order.mjs, which writes it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  writeFailure,
  writeStatus,
  markAbandoned,
  abandonedBranchDrift,
  activeRunDetails,
  chainRuns,
  startedRuns,
  taskFingerprint,
  readJson,
} from '../write-meta.mjs';
import { attach } from './attach.mjs';
import { setRun } from './run-context.mjs';
import { loadRunEnv, RUN_ENV } from './run-env.mjs';
import { parseArgs, die } from './args.mjs';
import { settleTaskInput } from './task-input.mjs';
import { parseContinuationGrant } from '../required-inputs.mjs';
import { continuationRefusal } from './continuation.mjs';
import { SCHEMAS } from './schemas.mjs';
import { INSTRUCTIONS } from './prompts.mjs';
import { git, headSha, branchName, worktreeSnapshot, reviewScope } from './git-state.mjs';
import { codexArgs, runMode, runProfile } from './codex-args.mjs';
import { writeWorkerOrder } from './worker-order.mjs';
import { requireCodex, unsafeForCmd } from './codex-cmd.mjs';
import { runsRoot } from './runs-root.mjs';
import { resolveProjectRunsDir } from './project-dir.mjs';
import { cleanupRetention } from '../retention.mjs';
import { renderConventions } from './conventions.mjs';
import { validateScope } from './scope-check.mjs';

/**
 * The worker is this same program re-invoked as `--worker <runDir>`, so the path spawned
 * below is the CLI entry one level up — not this module, which has no command line of its own.
 */
const RUNNER_ENTRY = fileURLToPath(new URL('../run-codex.mjs', import.meta.url));
export const questionsFromFlags = (questionTexts = []) =>
  questionTexts.map((text, i) => ({ id: `Q${i + 1}`, text }));

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * Never reuse a run folder. Two runs with the same slug inside the same second would
 * otherwise overwrite each other's task.md, log and result — and a status could then be
 * computed from another run's artifacts.
 */
export function makeRunDir(base) {
  fs.mkdirSync(path.dirname(base), { recursive: true });
  for (let n = 2, dir = base; ; n += 1) {
    try {
      fs.mkdirSync(dir);
      return dir;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      dir = `${base}-${n}`;
    }
  }
}

export const runDirPath = (root, slug, runStamp = stamp()) => {
  // `2026-08-13_235525_2026-08-13_plan4-6g-ceiling-scope` duplicated the order date. Only the
  // directory copy is stripped: the slug stored in status.json stays verbatim, because a run
  // with neither order_id nor task_hash is found by its stored slug alone (meta/chain.mjs).
  const stripped = String(slug).replace(/^\d{4}-\d{2}-\d{2}[_-]/, '');
  // An order id that is nothing but a date would otherwise name a folder ending in `_`.
  const directorySlug = stripped || String(slug);
  return path.join(root, `${runStamp}_${directorySlug}`);
};

/**
 * Everything a run needs before a single token of someone else's quota is spent, and every
 * refusal that costs nothing: bad arguments, an open chain without --continue, a busy
 * worktree, a missing Codex CLI. All of it happens here, in the process the caller is free
 * to kill — so a killed caller can only ever interrupt a run that was already paid for.
 */
export async function launcher(argv = process.argv.slice(2)) {
  loadRunEnv();
  const opts = parseArgs(argv);
  const taskText = settleTaskInput(opts);
  const topLevel = git(opts.repo, ['rev-parse', '--show-toplevel']);
  const isGitRepo = topLevel.status === 0;
  const repoRoot = isGitRepo ? topLevel.stdout.trim() : opts.repo;
  // Plan_27 moved impossible scope failures ahead of the run directory: an absolute pattern had
  // already cost 18 minutes before the verdict could prove it matched nothing.
  // Every agent, not only the writing one: a pattern that cannot match gives a scout empty coverage
  // instead of an answer. Only codex-build may declare a not-yet-existing path, so only its scope
  // carries --scope-new; for the other two the list is empty and every pattern must match.
  const scopeRefusal = validateScope(repoRoot, opts.scopePatterns, opts.scopeNewPatterns);
  if (scopeRefusal) {
    die(
      `--scope pattern ${JSON.stringify(scopeRefusal.pattern)} refused: ${scopeRefusal.reason}. ` +
        `Action: ${scopeRefusal.action}. The run folder was not created; quota was not spent.`,
    );
  }
  const projectRunsRoot = resolveProjectRunsDir(runsRoot(), repoRoot).dir;

  // Folders left behind by a runner that was killed mid-run get an explicit state before
  // anything else happens. One order produced four of them, and without this pass an
  // abandoned folder is indistinguishable from a run still working: neither has meta.json.
  // The snapshot is passed in because meta/ makes no git calls of its own: it is the only way an
  // abandoned run can be closed with the files it left behind rather than with a bare label.
  markAbandoned(projectRunsRoot, isGitRepo ? worktreeSnapshot(repoRoot) : undefined);

  if (isGitRepo) {
    const drift = abandonedBranchDrift(projectRunsRoot, repoRoot, branchName(repoRoot));
    if (drift) {
      die(
        `repository is detached after abandoned run ${drift.run}, which recorded branch ${drift.branch}. ` +
          `Return with: git checkout ${drift.branch}. No run folder was created and no quota was spent.`,
      );
    }
  }

  // A second pass at the same task is a real need — after a timeout or a LIMIT the work has
  // to be finished — so it is allowed and made visible rather than forbidden. What is
  // forbidden is repeating by accident: the orchestrator saw the previous reply, the runner
  // did not, so only the orchestrator can decide there is something left to finish.
  //
  // The task is identified by its text as well as by its slug, because the slug is chosen by
  // whoever repeats the run: on 2026-08-02 a dispatcher whose launcher was killed restarted
  // the identical order as `<slug>-v2` and spent 46k on it. Refused before the folder exists,
  // like --scope.
  const taskHash = taskFingerprint(taskText);
  const chain = chainRuns(projectRunsRoot, repoRoot, opts.slug, taskHash, opts.orderId);
  const startedChain = startedRuns(projectRunsRoot, chain);
  const continuationGrant = parseContinuationGrant(taskText);

  // The 2026-08-10_220535_plan25-2-install-table-two-roots incident exposed this ordering:
  // a grant without its flag must refuse before attach can print an older run's verdict.
  // markAbandoned() ran before this gate, so a dead runner already has meta.json with FAIL.
  // A run without a verdict can therefore only still be in flight; ordinary repeats go through
  // attach(), while --continue must refuse to overlap that live work.
  const continuationError = continuationRefusal(
    projectRunsRoot,
    startedChain,
    opts.continue,
    opts.orderId,
    continuationGrant,
  );
  if (continuationError) die(continuationError);

  // One order produced six Codex runs on 2026-08-03 because the caller's time ceiling made it
  // restart the synchronous launcher. A live same-order run is now the repeat target: attach
  // before creating a folder, probing Codex or spending another token.
  const attachedExitCode = await attach({
    runsRoot: projectRunsRoot,
    repo: repoRoot,
    slug: opts.slug,
    taskHash,
    orderId: opts.orderId,
    chain,
    isContinue: opts.continue,
    noWait: opts.noWait,
  });
  if (attachedExitCode !== null) return attachedExitCode;

  if (startedChain.length && !opts.continue) {
    const last = startedChain[startedChain.length - 1];
    const lastSlug = String(readJson(path.join(projectRunsRoot, last, 'status.json'))?.slug || '');
    const renamed = lastSlug && lastSlug.toLowerCase() !== String(opts.slug).toLowerCase();
    die(
      `--continue is required: ${
        renamed
          ? `this task already ran in this repository under the name “${lastSlug}”`
          : `runs for task “${opts.slug}” already exist in this repository`
      } (${startedChain.length}), latest: ${path.join(projectRunsRoot, last)}. ` +
        'A repeat run is allowed, but the orchestrator decides, not the runner: it read the ' +
        'previous response and knows whether work remains. Add --continue if you are finishing ' +
        'the same task; changing --slug with the same task text does not stop it being a repeat. ' +
        'The run folder was not created; quota was not spent.',
    );
  }

  // Asked before this run registers itself, so it cannot find itself. Two writing runs share
  // one worktree with no isolation: the second one's before/after snapshot picks up the
  // first one's edits, and an honest run gets failed for work it never did.
  const busy = opts.agent === 'codex-build' ? activeRunDetails(projectRunsRoot, repoRoot) : null;

  let retention = null;
  try {
    retention = cleanupRetention(projectRunsRoot, RUN_ENV?.retention);
  } catch {
    // Plan_17 step 4 makes retention advisory housekeeping: one broken filesystem call must never
    // block a new run.
    retention = null;
  }

  const runDir = makeRunDir(runDirPath(projectRunsRoot, opts.slug));
  setRun(runDir, opts.agent);

  // Written before Codex is even probed. From here on a killed runner leaves a folder that
  // says what it was and whose pid to check, instead of a folder that says nothing — the run
  // itself takes 20-25 minutes, far longer than the caller's default timeout, so being killed
  // mid-run is the normal way for this to end, not the exotic one.
  //
  // `pid` is the launcher's only until the worker exists, and the worker's from then on:
  // activeRun(), markAbandoned() and the reply guard all read `pid` as "the process whose
  // death means this run is abandoned", and after the spawn that process is the worker.
  writeStatus(runDir, {
    state: 'running',
    pid: process.pid,
    launcher_pid: process.pid,
    process_started_at: performance.timeOrigin,
    agent: opts.agent,
    slug: opts.slug,
    order_id: opts.orderId,
    // Fingerprint of the order, so a later run of the same task finds this one whatever it
    // calls itself. Written here, before Codex is probed, like everything the chain reads.
    task_hash: taskHash,
    repo: repoRoot,
    started_at: new Date().toISOString(),
    // Which run of this task started the chain — the base every later pass is measured
    // against. Absent means this is the first pass.
    ...(startedChain.length ? { continues: startedChain[0] } : {}),
    // `continued_from` is the exact run the orchestrator named; `continues` above remains the chain base.
    ...(continuationGrant ? { continued_from: continuationGrant.run } : {}),
    ...(retention ? { retention } : {}),
  });

  // Printed before anything can go wrong: even a dispatcher that dies mid-run leaves the
  // orchestrator with a folder to look into.
  console.log(`RUN=${runDir} order-id=${opts.orderId}`);

  // Before requireCodex, so a blocked run costs nothing at all.
  if (busy) {
    const identityNote = busy.identity === 'unverified'
      ? '; process identity could not be confirmed'
      : '';
    const { reply } = writeFailure(
      runDir,
      opts.agent,
      `run ${busy.run} is already active for this repository; two writing runs in one tree are prohibited${identityNote}`,
      [`Active run: ${path.join(projectRunsRoot, busy.run)}`, 'Codex was not started; quota was not spent'],
      true,
    );
    console.log(reply);
    return 1;
  }

  requireCodex(runDir, opts.agent);

  const scope = opts.agent === 'codex-review' ? reviewScope(repoRoot, opts.mode) : null;
  if (scope) {
    fs.writeFileSync(
      path.join(runDir, 'scope.txt'),
      `${scope.label}\n${scope.diffCommand}\n${scope.files.join('\n')}\n`,
    );
  }

  // The sub-questions this run will be graded against come only from the orchestrator's
  // repeatable flags. They are written before the task is assembled so the prompt and verdict
  // read the same ordered list, including a valid one-question order.
  const questions = opts.agent === 'codex-scout' ? questionsFromFlags(opts.questions) : [];
  if (opts.agent === 'codex-scout') {
    fs.writeFileSync(path.join(runDir, 'questions.json'), `${JSON.stringify(questions, null, 2)}\n`);
  }

  if (opts.agent === 'codex-build') {
    fs.writeFileSync(path.join(runDir, 'scope.txt'), `${opts.scopePatterns.join('\n')}\n`);
  }

  // Which environment this run actually got. Without it a replay months later cannot tell
  // whether the operator's hooks were in play, and that is the first question a run that
  // wandered off task raises.
  fs.writeFileSync(path.join(runDir, 'env.json'), `${JSON.stringify(RUN_ENV, null, 2)}\n`);

  // The extra sections carry the two things prose could not enforce: what has to be answered,
  // and what may be edited. Both also go to disk as questions.json / scope.txt, so the verdict
  // is computed from the same list Codex was handed, not from a second reading of the wording.
  const sections = [`## Operator task (verbatim)\n\n${taskText}`];
  if (questions.length) {
    sections.push(
      [
        '## Sub-questions, each requires a separate response',
        '',
        questions.map((q) => `${q.id}: ${q.text}`).join('\n'),
        '',
        'A missed sub-question fails the run; a response containing only coordinates counts as missed.',
      ].join('\n'),
    );
  }
  if (opts.agent === 'codex-build') {
    sections.push(
      [
        '## Scope (hard boundary)',
        '',
        'Only these may be changed:',
        opts.scopePatterns.map((p) => `- ${p}`).join('\n'),
        '',
        'Do not touch any file outside this list — even if it blocks the work or looks broken.',
        'Put the obstacle in leftovers instead of changing the file. The touched worktree is',
        'checked against this list after the run.',
      ].join('\n'),
    );
  }
  const conventions = renderConventions(repoRoot);
  if (conventions) sections.push(conventions);
  sections.push(`## Instructions for Codex\n\n${INSTRUCTIONS[opts.agent](opts, scope, questions)}`);
  fs.writeFileSync(path.join(runDir, 'task.md'), `${sections.join('\n\n')}\n`);
  fs.writeFileSync(
    path.join(runDir, 'schema.json'),
    `${JSON.stringify(SCHEMAS[opts.agent], null, 2)}\n`,
  );

  if (opts.agent === 'codex-build') {
    fs.writeFileSync(path.join(runDir, 'head-before.txt'), `${isGitRepo ? headSha(repoRoot) : ''}\n`);
    fs.writeFileSync(path.join(runDir, 'branch-before.txt'), `${isGitRepo ? branchName(repoRoot) : ''}\n`);
    fs.writeFileSync(path.join(runDir, 'git-before.txt'), git(repoRoot, ['status', '--porcelain']).stdout || '');
    fs.writeFileSync(path.join(runDir, 'state-before.txt'), `${worktreeSnapshot(repoRoot)}\n`);
  }

  // The worker's entire order, on disk. Not passed as arguments: the launcher may be gone
  // when the worker needs to know what it is doing, and a folder that explains itself is
  // also the only way to read a run back months later.
  const codexArgv = codexArgs({ ...opts, repo: repoRoot }, runDir, isGitRepo);
  const unsafe = process.platform === 'win32' ? unsafeForCmd(codexArgv) : undefined;
  if (unsafe) {
    const { reply } = writeFailure(
      runDir,
      opts.agent,
      `argument cannot be passed through cmd.exe (contains % or "): ${unsafe}`,
      ['Codex was not started; quota was not spent'],
      true,
    );
    console.log(reply);
    return 1;
  }
  writeWorkerOrder(runDir, {
    agent: opts.agent,
    slug: opts.slug,
    orderId: opts.orderId,
    repo: repoRoot,
    isGitRepo,
    launcherPid: process.pid,
    budgetMinutes: RUN_ENV?.budgets?.[runMode(opts.agent)],
    scopeNew: opts.scopeNewPatterns,
    profile: runProfile({ ...opts, repo: repoRoot }),
    args: codexArgv,
  });

  // detached + unref + no stdio: the worker leaves the caller's process group, so a Ctrl+C
  // or a timeout kill aimed at the dispatcher's shell does not reach it, and it holds no
  // pipe that could fill up and stall once nobody is reading.
  const worker = spawn(process.execPath, [RUNNER_ENTRY, '--worker', runDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: repoRoot,
  });
  const started = await new Promise((resolve) => {
    worker.once('spawn', () => resolve(true));
    worker.once('error', (err) => {
      const { reply } = writeFailure(runDir, opts.agent, `run worker process failed to start: ${err.message}`, [
        'Codex was not started; quota was not spent',
      ], true);
      console.log(reply);
      resolve(false);
    });
  });
  if (!started) return 1;
  worker.unref();
  writeStatus(runDir, { pid: worker.pid, runner_pid: worker.pid, process_started_at: null });

  console.log(
    `STARTED agent=${opts.agent} slug=${opts.slug} order-id=${opts.orderId} worker-pid=${worker.pid}`,
  );
  console.log(
    'To get the verdict, repeat the identical command with the same --order-id; it will attach to this run and will not start a second run.',
  );
  return 0;
}
