/**
 * The half the caller can kill: every preparation and every refusal that costs no quota,
 * then the spawn of the worker and the immediate return; a repeated call waits for the reply.
 *
 * worker.json in the run folder is the only connection between the two halves after the split.
 * worker-order.mjs writes it and owns its shape and the reason for every field.
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
} from '../write-meta.mjs';
import { TASK_HASH_SCHEME } from '../meta/chain.mjs';
import { EXIT } from './exit-codes.mjs';
import { passGate } from './pass-gate.mjs';
import { setRun } from './run-context.mjs';
import { loadRunEnv, RUN_ENV } from './run-env.mjs';
import { parseArgs, die } from './args.mjs';
import { settleTaskInput } from './task-input.mjs';
import { questionsFromTexts, QUESTION_KIND } from './question-kind.mjs';
import { adviseSection } from './advise-carry.mjs';
import { schemaFor } from './schemas.mjs';
import { INSTRUCTIONS } from './prompts.mjs';
import { git, branchName, worktreeSnapshot, reviewScope } from './git-state.mjs';
import { writeBuildBefore } from './build-evidence.mjs';
import { agentRole } from '../agents.mjs';
import { codexArgs, runProfile } from './codex-args.mjs';
import { writeWorkerOrder } from './worker-order.mjs';
import { unsafeForCmd } from './codex-cmd.mjs';
import { runsRoot } from './runs-root.mjs';
import { resolveProjectRunsDir } from './project-dir.mjs';
import { cleanupRetention } from '../retention.mjs';
import { renderConventions } from './conventions.mjs';
import { validateScope } from './scope-check.mjs';
import { probeSandbox, sandboxRefusal } from './sandbox-probe.mjs';
import {
  codexAvailabilityRefusal, preflightRefusal, resolveRunPhase, taskPreflight,
} from './preflight.mjs';

/**
 * The worker is this same program re-invoked as `--worker <runDir>`, so the path spawned
 * below is the CLI entry one level up — not this module, which has no command line of its own.
 */
const RUNNER_ENTRY = fileURLToPath(new URL('../run-codex.mjs', import.meta.url));

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
 * worktree, a dead Codex sandbox, a missing Codex CLI. All in the process the caller is free
 * to kill — so a killed caller can only ever interrupt a run that was already paid for.
 */
export async function launcher(argv = process.argv.slice(2)) {
  loadRunEnv();
  const opts = parseArgs(argv);
  opts.phase = resolveRunPhase(opts, RUN_ENV.budgets);
  const { task: taskText, header } = settleTaskInput(opts);
  // Plan_59 D5/D6: blind choices and design authority must be checked before the paid probe.
  const taskGate = taskPreflight({ agent: opts.agent, taskText, header });
  if (taskGate.refusal) die(taskGate.refusal, EXIT.FAIL);
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

  // The pass gate lives in pass-gate.mjs, Plan_75 P0.
  const gate = await passGate({ opts, taskText, header, projectRunsRoot, repoRoot });
  if ('exitCode' in gate) return gate.exitCode;
  const { taskHash, chain, startedChain, continuationGrant, advisorTask, retryOf } = gate;

  // Plan_60 D2: a missing or signed-out Codex answers UNAVAILABLE (exit 5) before the paid sandbox probe.
  const availability = await codexAvailabilityRefusal();
  if (availability?.unavailable) { process.stdout.write(`${availability.text}\n`); return EXIT.UNAVAILABLE; }
  if (availability) die(availability.text, EXIT.FAIL);
  // Review 2026-09-17: probe before the busy check so it sees writers that registered while the slow
  // probe waited; the dead refusal stays before retention to preserve old run artifacts.
  const sandboxProbe = await probeSandbox({ agent: opts.agent, repo: repoRoot });
  if (sandboxProbe.outcome === 'dead') die(sandboxRefusal(sandboxProbe));

  // Everything that can refuse without touching the tree is asked here, after the probe so the
  // busy check sees writers that registered while it waited, and before makeRunDir below: on
  // 2026-09-19 a busy refusal left its folder inside ~/.claude and the live run's witness spent
  // every tool call demanding the orchestrator revert a directory the tool itself had created.
  // Exit 1, not the usage code 2: the order was correct, the host or the tree was not.
  const preflightError = preflightRefusal({ agent: opts.agent, projectRunsRoot, repoRoot });
  if (preflightError) die(preflightError, EXIT.FAIL);

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

  // Written before the worker can start. From here on a killed runner leaves a folder that
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
    phase: opts.phase,
    ...(taskGate.advice === undefined ? {} : { advice: taskGate.advice }),
    // Fingerprint of the order, so a later run of the same task finds this one whatever it
    // calls itself. Written here, before Codex starts, like everything the chain reads.
    task_hash: taskHash,
    task_hash_scheme: TASK_HASH_SCHEME,
    repo: repoRoot,
    started_at: new Date().toISOString(),
    // Which run of this task started the chain — the base every later pass is measured
    // against. Absent means this is the first pass.
    ...(startedChain.length ? { continues: startedChain[0] } : {}),
    // `continued_from` is the exact run the orchestrator named; `continues` above remains the chain base.
    ...(continuationGrant ? { continued_from: continuationGrant.run } : {}),
    // Plan_75: the repeated failed run; pass accounting skips runs carrying it.
    ...(retryOf ? { retry_of: retryOf } : {}),
    ...(retention ? { retention } : {}),
    sandbox_probe: sandboxProbe,
  });

  // Printed before anything can go wrong: even a dispatcher that dies mid-run leaves the
  // orchestrator with a folder to look into.
  console.log(`RUN=${runDir} order-id=${opts.orderId}`);

  const scope = opts.agent === 'codex-review' ? reviewScope(repoRoot, opts.changeset) : null;
  if (scope) {
    fs.writeFileSync(
      path.join(runDir, 'scope.txt'),
      `${scope.label}\n${scope.diffCommand}\n${scope.files.join('\n')}\n`,
    );
  }

  // The sub-questions this run will be graded against come only from the orchestrator's
  // repeatable flags. They are written before the task is assembled so the prompt and verdict
  // read the same ordered list, including a valid one-question order.
  const questions = opts.agent === 'codex-scout' ? questionsFromTexts(opts.questions) : [];
  if (opts.agent === 'codex-scout') {
    fs.writeFileSync(path.join(runDir, 'questions.json'), `${JSON.stringify(questions, null, 2)}\n`);
  }
  if (advisorTask) fs.writeFileSync(path.join(runDir, 'advisor-task.json'), `${JSON.stringify(advisorTask, null, 2)}\n`);

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
  const scopeResults = adviseSection(advisorTask);
  if (scopeResults) sections.push(scopeResults);
  if (questions.length) {
    sections.push(
      [
        '## Sub-questions, each requires a separate response',
        '',
        questions.map((q) =>
          `${q.id}${q.kind === QUESTION_KIND.STARTUP_CONTEXT ? ' [context-only]' : ''}: ${q.text}`).join('\n'),
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
    `${JSON.stringify(schemaFor(opts.agent, opts.phase), null, 2)}\n`,
  );

  if (opts.agent === 'codex-build') writeBuildBefore({ runDir, repoRoot, isGitRepo });

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
    return EXIT.FAIL;
  }
  writeWorkerOrder(runDir, {
    agent: opts.agent,
    slug: opts.slug,
    orderId: opts.orderId,
    repo: repoRoot,
    isGitRepo,
    launcherPid: process.pid,
    phase: opts.phase,
    budgetMinutes: RUN_ENV.budgets[agentRole(opts.agent)][opts.phase],
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
  if (!started) return EXIT.FAIL;
  worker.unref();
  writeStatus(runDir, { pid: worker.pid, runner_pid: worker.pid, process_started_at: null });

  console.log(
    `STARTED agent=${opts.agent} slug=${opts.slug} order-id=${opts.orderId} worker-pid=${worker.pid}`,
  );
  console.log(
    'To get the verdict, repeat the identical command with the same --order-id; it will attach to this run and will not start a second run.',
  );
  return EXIT.OK;
}
