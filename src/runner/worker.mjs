/**
 * The half that outlives the caller: Codex itself, the "after" snapshots, the verdict.
 *
 * It takes its whole order from worker.json, written by launcher.mjs into the run folder —
 * after the split that file is the only connection between the two halves. Read here:
 * `repo`, `agent`, `args`, `is_git_repo`, `budget_minutes`. Written there: those five plus
 * `slug`, `launcher_pid` and `scope_new`, which nothing here needs but a run folder read back
 * months later does. The launcher must write the selected mode's budget into worker.json before
 * spawning this half, so the worker never re-reads run-config.json and one run cannot acquire two
 * configurations.
 * Neither side may change the shape alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFileSync } from '../json-file.mjs';
import { collect, exitCodeFor, AGENTS } from '../write-meta.mjs';
import { writeStatus } from '../meta/run-state.mjs';
import { setRun, emitReply } from './run-context.mjs';
import { git, headSha, branchName, worktreeSnapshot, findFakeDone } from './git-state.mjs';
import { runCodex } from './codex-cmd.mjs';

/**
 * Runs the order in runDir and answers into reply.txt, never to a console — nothing here
 * may depend on anyone still being on the other end of a pipe.
 */
export async function worker(runDir) {
  const cfg = readJsonFileSync(path.join(runDir, 'worker.json'));
  const repoRoot = cfg.repo;
  setRun(runDir, cfg.agent);
  // The launcher cannot know this detached process's clock origin; takeover must record the
  // worker's own identity before it starts producing the run's artifacts.
  writeStatus(runDir, {
    pid: process.pid,
    runner_pid: process.pid,
    process_started_at: performance.timeOrigin,
  });

  const run = await runCodex(
    cfg.args,
    fs.readFileSync(path.join(runDir, 'task.md'), 'utf8'),
    path.join(runDir, 'events.jsonl'),
    cfg.budget_minutes,
  );
  // This runner-owned fact cannot be forged through events.jsonl, which Codex can write.
  // Written even when no deadline fired: `false` is the marker that a runner was watching,
  // and an archived run with no field at all must stay distinguishable from a run that lived.
  // `stdio_drained: false` separately records an exit that needed the grace fallback because
  // a grandchild kept a pipe open, the distinction the 2026-08-06 incident made necessary.
  writeStatus(runDir, {
    stopped_on_deadline: run.stoppedOnDeadline,
    elapsed_ms: run.elapsedMs,
    stdio_drained: run.stdioDrained,
  });

  if (cfg.agent === 'codex-build') {
    fs.writeFileSync(path.join(runDir, 'head-after.txt'), `${cfg.is_git_repo ? headSha(repoRoot) : ''}\n`);
    fs.writeFileSync(path.join(runDir, 'branch-after.txt'), `${cfg.is_git_repo ? branchName(repoRoot) : ''}\n`);
    fs.writeFileSync(path.join(runDir, 'git-after.txt'), git(repoRoot, ['status', '--porcelain']).stdout || '');
    fs.writeFileSync(path.join(runDir, 'state-after.txt'), `${worktreeSnapshot(repoRoot)}\n`);
    fs.writeFileSync(path.join(runDir, 'diff.stat'), git(repoRoot, ['diff', '--stat']).stdout || '');
    fs.writeFileSync(path.join(runDir, 'flags.txt'), findFakeDone(repoRoot));
  }

  // Human-readable report is carried inside the schema: a read-only scout cannot write
  // files itself, so the runner unpacks it.
  const resultPath = path.join(runDir, AGENTS[cfg.agent].result);
  if (cfg.agent !== 'codex-review') {
    try {
      const result = readJsonFileSync(resultPath);
      if (result.report_markdown) fs.writeFileSync(path.join(runDir, 'report.md'), `${result.report_markdown}\n`);
    } catch {
      // No parseable result — write-meta.mjs turns that into FAIL with the log reason.
    }
  }

  // collect() writes meta.json and closes status.json; reply.txt comes last, so the launcher
  // seeing a reply is proof the verdict behind it is already on disk.
  const { meta, reply } = collect(runDir, cfg.agent, run.exit);
  emitReply(reply);
  process.exit(exitCodeFor(meta.status));
}
