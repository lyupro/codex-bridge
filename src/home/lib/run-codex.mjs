#!/usr/bin/env node
/**
 * Runs one delegated Codex job end to end:
 *   node run-codex.mjs --agent <codex-scout|codex-build|codex-review> [options] < task.txt
 *   codex-bridge run --agent <codex-scout|codex-build|codex-review> [options] --task-file task.txt
 *
 * Options:
 *   --agent     codex-scout | codex-build | codex-review   (required)
 *   --repo      repository path (default: current directory)
 *   --slug      short run name used in the run folder (default: agent suffix)
 *   --effort    reasoning effort, passed to Codex as given (default: medium)
 *   --verify    verification command, codex-build only (e.g. "npm test")
 *   --scope     comma-separated globs the run may edit, codex-build only (required there)
 *   --mode      uncommitted | base:<branch> | commit:<sha>, codex-review only
 *   --continue  acknowledge that this repo+slug already has runs (required if it does)
 *
 * The operator's task text arrives verbatim through stdin or --task-file.
 *
 * Why this is a script and not a list of steps inside an agent prompt: a prompt can be
 * silently not followed, and twice it wasn't — one dispatcher reviewed the diff itself
 * after Codex disappointed it, another announced a background run that never existed.
 * Here the caller still blocks until a verdict exists on disk, the status is computed from
 * artifacts by write-meta.mjs, and the reply is printed by code. "Started in the
 * background, will report later" and "I analyzed it myself instead" are unreachable.
 *
 * This file is two programs. A plain call is the LAUNCHER: it does every preparation and
 * every refusal that costs no quota, then spawns the WORKER — this same file called as
 * `--worker <runDir>`, detached, with no stdio — prints `RUN=<folder>` immediately and waits
 * for the worker's reply.txt, which it prints verbatim. The worker runs Codex, snapshots the
 * tree and writes the verdict.
 *
 * The split exists because the caller dies long before a 20-25 minute run does. Run
 * `2026-07-31_114736_*` has no events.jsonl at all while 11+ files were written into the tree: the
 * dispatcher's Bash call hit its two-minute timeout, node was killed, spawnSync's buffered
 * output died with it — and Codex kept going, unwatched and unrecorded. Killing that orphan
 * is not the fix either: its edits were the work, and later runs finished on top of them. So
 * the process the caller can kill is now the launcher, and the worker it leaves behind closes
 * the run with artifacts whether anyone is still listening or not.
 *
 * The work itself lives in runner/, one concern per module and the imports pointing one way:
 * run-context.mjs holds the run in progress and answers for it, run-env.mjs decides what
 * environment a run gets, args.mjs reads and refuses the command line, schemas.mjs and
 * prompts.mjs are what each agent is asked for and told, git-state.mjs reads the repository,
 * codex-cmd.mjs invokes the Codex CLI, and launcher.mjs / worker.mjs are the two halves
 * above. This file is the command line and the fork between them; importers name it and
 * nothing below it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFailure } from './write-meta.mjs';
import { setWorkerDir, getRun, emitReply } from './runner/run-context.mjs';
import { launcher } from './runner/launcher.mjs';
import { worker } from './runner/worker.mjs';
import { RunnerUsageError } from './runner/args.mjs';

export { parseArgs } from './runner/args.mjs';
export { runsPrefixInside, worktreeSnapshot } from './runner/git-state.mjs';

// `--worker <runDir>` and nothing else: the worker takes its whole order from worker.json in
// that folder, so a half-parsed command line cannot make the two halves disagree about which
// run they are working on.
/**
 * Only a direct call is a run. Imported — which is how the tests reach parseArgs(),
 * runsPrefixInside() and worktreeSnapshot() — this file must do nothing at all: no argument
 * parsing, no stdin, no spawn, not even a global crash handler that would swallow someone
 * else's exception. Same guard run-config.mjs and write-meta.mjs already use.
 */
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

// A crash of the runner itself still has to read as a FAIL, and that FAIL still has to
// be backed by meta.json — otherwise there would be a second path by which a reply
// exists without an artifact behind it, which is the whole failure mode this design
// removes. Before the run folder exists there is nowhere to write, so the reply says so.
//
// One handler, here, for both halves: it has to catch a crash whichever branch below is
// running, and a second registration inside launcher.mjs or worker.mjs would be a second
// answer to the same question.
if (invokedDirectly) {
  process.on('uncaughtException', (err) => {
    const { dir: currentRun, agent: currentAgent } = getRun();
    if (currentRun) {
      try {
        fs.appendFileSync(path.join(currentRun, 'stderr.log'), `\nrun-codex crash: ${err.stack}\n`);
        const { reply } = writeFailure(currentRun, currentAgent, `Codex runner crashed: ${err.message}`, [
          `Log: codex-bridge read ${currentRun}`,
        ]);
        emitReply(reply);
        process.exit(1);
      } catch {
        // Falls through to the bare reply below: the disk itself is not cooperating.
      }
    }
    emitReply(
      [
        `FAIL — Codex runner crashed before creating the run folder: ${String(err.message).replace(/\s+/g, ' ').slice(0, 150)}`,
        'No artifacts; nothing to inspect',
      ].join('\n'),
    );
    process.exit(1);
  });
}

/**
 * The package command and the historical file entry both cross this boundary. Keeping argv
 * explicit prevents the public command from reconstructing or normalizing runner flags, while
 * the worker sentinel remains private to the direct file invocation spawned by launcher.mjs.
 */
export async function runCodex(argv) {
  const workerDir = argv[0] === '--worker' ? argv[1] : null;
  setWorkerDir(workerDir);
  try {
    if (workerDir) return worker(workerDir);
    return await launcher(argv);
  } catch (err) {
    if (err instanceof RunnerUsageError) return err.exitCode;
    throw err;
  }
}

if (invokedDirectly) {
  runCodex(process.argv.slice(2)).then((exitCode) => {
    if (exitCode !== undefined) process.exitCode = exitCode;
  }, (err) => {
    // Preserve the direct entry's artifact-backed crash path for asynchronous launcher failures.
    queueMicrotask(() => { throw err; });
  });
}
