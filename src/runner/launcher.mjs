/**
 * The half the caller can kill: every preparation and every refusal that costs no quota,
 * then the spawn of the worker and the wait for its reply.
 *
 * The order it leaves for the worker is worker.json in the run folder — after the split
 * that file is the only connection between the two halves. It is written here with
 * `agent`, `slug`, `repo`, `is_git_repo`, `launcher_pid` and `args`; worker.mjs reads
 * `repo`, `agent`, `args` and `is_git_repo`. The two extra fields are deliberate: `slug`
 * and `launcher_pid` are what a run folder read back months later needs in order to
 * explain itself. Nothing may be dropped from this shape without changing worker.mjs and
 * saying so out loud.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  exitCodeFor,
  writeFailure,
  parseQuestions,
  writeStatus,
  markAbandoned,
  abandonedBranchDrift,
  activeRun,
  chainRuns,
  taskFingerprint,
  readJson,
} from '../write-meta.mjs';
import { setRun } from './run-context.mjs';
import { loadRunEnv, RUN_ENV } from './run-env.mjs';
import { parseArgs, die } from './args.mjs';
import { SCHEMAS } from './schemas.mjs';
import { INSTRUCTIONS } from './prompts.mjs';
import { git, headSha, branchName, worktreeSnapshot, reviewScope } from './git-state.mjs';
import { codexArgs, requireCodex, unsafeForCmd } from './codex-cmd.mjs';
import { runsRoot } from './runs-root.mjs';
import { resolveProjectRunsDir } from './project-dir.mjs';

// How often the launcher looks for the worker's reply. A run lasts 20-25 minutes, so the
// interval only decides how promptly the caller is released at the end of it.
const POLL_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The worker is this same program re-invoked as `--worker <runDir>`, so the path spawned
 * below is the CLI entry one level up — not this module, which has no command line of its own.
 */
const RUNNER_ENTRY = fileURLToPath(new URL('../run-codex.mjs', import.meta.url));

const readJsonFile = (file) => {
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
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

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
function makeRunDir(base) {
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

/**
 * Everything a run needs before a single token of someone else's quota is spent, and every
 * refusal that costs nothing: bad arguments, an open chain without --continue, a busy
 * worktree, a missing Codex CLI. All of it happens here, in the process the caller is free
 * to kill — so a killed caller can only ever interrupt a run that was already paid for.
 */
export async function launcher() {
  loadRunEnv();

  const opts = parseArgs(process.argv.slice(2));
  const taskText = fs.readFileSync(0, 'utf8').trim();
  if (!taskText) die('task text on stdin is empty');

  const topLevel = git(opts.repo, ['rev-parse', '--show-toplevel']);
  const isGitRepo = topLevel.status === 0;
  const repoRoot = isGitRepo ? topLevel.stdout.trim() : opts.repo;
  const projectRunsRoot = resolveProjectRunsDir(runsRoot(), repoRoot).dir;

  // Folders left behind by a runner that was killed mid-run get an explicit state before
  // anything else happens. One order produced four of them, and without this pass an
  // abandoned folder is indistinguishable from a run still working: neither has meta.json.
  markAbandoned(projectRunsRoot);

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
  const chain = chainRuns(projectRunsRoot, repoRoot, opts.slug, taskHash);
  if (chain.length && !opts.continue) {
    const last = chain[chain.length - 1];
    const lastSlug = String(readJson(path.join(projectRunsRoot, last, 'status.json'))?.slug || '');
    const renamed = lastSlug && lastSlug.toLowerCase() !== String(opts.slug).toLowerCase();
    die(
      `--continue is required: ${
        renamed
          ? `this task already ran in this repository under the name “${lastSlug}”`
          : `runs for task “${opts.slug}” already exist in this repository`
      } (${chain.length}), latest: ${path.join(projectRunsRoot, last)}. ` +
        'A repeat run is allowed, but the orchestrator decides, not the runner: it read the ' +
        'previous response and knows whether work remains. Add --continue if you are finishing ' +
        'the same task; changing --slug with the same task text does not stop it being a repeat. ' +
        'The run folder was not created; quota was not spent.',
    );
  }

  // Asked before this run registers itself, so it cannot find itself. Two writing runs share
  // one worktree with no isolation: the second one's before/after snapshot picks up the
  // first one's edits, and an honest run gets failed for work it never did.
  const busy = opts.agent === 'codex-build' ? activeRun(projectRunsRoot, repoRoot) : null;

  const runDir = makeRunDir(path.join(projectRunsRoot, `${stamp()}_${opts.slug}`));
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
    agent: opts.agent,
    slug: opts.slug,
    // Fingerprint of the order, so a later run of the same task finds this one whatever it
    // calls itself. Written here, before Codex is probed, like everything the chain reads.
    task_hash: taskHash,
    repo: repoRoot,
    started_at: new Date().toISOString(),
    // Which run of this task started the chain — the base every later pass is measured
    // against. Absent means this is the first pass.
    ...(chain.length ? { continues: chain[0] } : {}),
  });

  // Printed before anything can go wrong: even a dispatcher that dies mid-run leaves the
  // orchestrator with a folder to look into.
  console.log(`RUN=${runDir}`);

  // Before requireCodex, so a blocked run costs nothing at all.
  if (busy) {
    const { reply } = writeFailure(
      runDir,
      opts.agent,
      `run ${busy} is already active for this repository; two writing runs in one tree are prohibited`,
      [`Active run: ${path.join(projectRunsRoot, busy)}`, 'Codex was not started; quota was not spent'],
    );
    console.log(reply);
    process.exit(1);
  }

  requireCodex(runDir, opts.agent);

  const scope = opts.agent === 'codex-review' ? reviewScope(repoRoot, opts.mode) : null;
  if (scope) {
    fs.writeFileSync(
      path.join(runDir, 'scope.txt'),
      `${scope.label}\n${scope.diffCommand}\n${scope.files.join('\n')}\n`,
    );
  }

  // The sub-questions this run will be graded against, extracted exactly the way write-meta
  // reads them back. Fewer than two means the order is one question, and grading falls back
  // to demanding one substantial answer instead of per-question coverage.
  const questions = opts.agent === 'codex-scout' ? parseQuestions(taskText) : [];
  if (questions.length) {
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
    );
    console.log(reply);
    process.exit(1);
  }
  fs.writeFileSync(
    path.join(runDir, 'worker.json'),
    `${JSON.stringify(
      {
        agent: opts.agent,
        slug: opts.slug,
        repo: repoRoot,
        is_git_repo: isGitRepo,
        launcher_pid: process.pid,
        args: codexArgv,
      },
      null,
      2,
    )}\n`,
  );

  // detached + unref + no stdio: the worker leaves the caller's process group, so a Ctrl+C
  // or a timeout kill aimed at the dispatcher's shell does not reach it, and it holds no
  // pipe that could fill up and stall once nobody is reading.
  const worker = spawn(process.execPath, [RUNNER_ENTRY, '--worker', runDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: repoRoot,
  });
  worker.on('error', (err) => {
    const { reply } = writeFailure(runDir, opts.agent, `run worker process failed to start: ${err.message}`, [
      'Codex was not started; quota was not spent',
    ]);
    console.log(reply);
    process.exit(1);
  });
  worker.unref();
  writeStatus(runDir, { pid: worker.pid, runner_pid: worker.pid });

  const replyText = await waitForReply(runDir, worker.pid);
  if (replyText !== null) {
    console.log(replyText);
    process.exit(exitCodeFor(readJsonFile(path.join(runDir, 'meta.json'))?.status));
  }

  // The worker died without leaving its reply. If it got as far as meta.json the verdict is
  // real and stays untouched — overwriting it would throw away the token accounting; if it
  // did not, the failure is recorded like any other, through meta.json.
  const meta = readJsonFile(path.join(runDir, 'meta.json'));
  if (meta) {
    console.log(
      [
        `${meta.status} — ${meta.reason || 'verdict recorded, worker process response not saved'}`,
        `Run: ${runDir}`,
      ].join('\n'),
    );
    process.exit(exitCodeFor(meta.status));
  }
  const { reply } = writeFailure(runDir, opts.agent, 'run worker process died without recording a verdict', [
    `Log: ${path.join(runDir, 'raw.log')}`,
    'Any Codex changes remain in the tree — check them with git status',
  ]);
  console.log(reply);
  process.exit(1);
}

/** Blocks until the worker's reply exists, or until the worker is provably gone without one. */
async function waitForReply(runDir, workerPid) {
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
