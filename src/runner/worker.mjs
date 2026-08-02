/**
 * The half that outlives the caller: Codex itself, the "after" snapshots, the verdict.
 *
 * It takes its whole order from worker.json, written by launcher.mjs into the run folder —
 * after the split that file is the only connection between the two halves. Read here:
 * `repo`, `agent`, `args`, `is_git_repo`. Written there: those four plus `slug` and
 * `launcher_pid`, which nothing here needs but a run folder read back months later does.
 * Neither side may change the shape alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { collect, exitCodeFor, AGENTS } from '../write-meta.mjs';
import { setRun, emitReply } from './run-context.mjs';
import { git, headSha, worktreeSnapshot, findFakeDone } from './git-state.mjs';
import { runCodex } from './codex-cmd.mjs';

/**
 * Runs the order in runDir and answers into reply.txt, never to a console — nothing here
 * may depend on anyone still being on the other end of a pipe.
 */
export async function worker(runDir) {
  const cfg = JSON.parse(fs.readFileSync(path.join(runDir, 'worker.json'), 'utf8'));
  const repoRoot = cfg.repo;
  setRun(runDir, cfg.agent);

  const exit = await runCodex(
    cfg.args,
    fs.readFileSync(path.join(runDir, 'task.md'), 'utf8'),
    path.join(runDir, 'raw.log'),
  );

  if (cfg.agent === 'codex-build') {
    fs.writeFileSync(path.join(runDir, 'head-after.txt'), `${cfg.is_git_repo ? headSha(repoRoot) : ''}\n`);
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
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      if (result.report_markdown) fs.writeFileSync(path.join(runDir, 'report.md'), `${result.report_markdown}\n`);
    } catch {
      // No parseable result — write-meta.mjs turns that into FAIL with the log reason.
    }
  }

  // collect() writes meta.json and closes status.json; reply.txt comes last, so the launcher
  // seeing a reply is proof the verdict behind it is already on disk.
  const { meta, reply } = collect(runDir, cfg.agent, exit);
  emitReply(reply);
  process.exit(exitCodeFor(meta.status));
}
