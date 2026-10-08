/**
 * Gives the moved run store the git history its records had in the repository they left.
 *
 * Plan_77 D4: split only a clone so the old repository's working tree, index and refs stay intact.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function runGit(cwd, args) {
  const { status, stdout, stderr } = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  return { status, stdout, stderr };
}

function gitFailure(step, result) {
  const firstLine = (result.stderr || '').trim().split(/\r?\n/)[0];
  return new Error(`Git ${step} failed (exit ${result.status}): ${firstLine}`);
}

function gitStep(git, cwd, args, statuses = [0]) {
  let result;
  try {
    result = git(cwd, args);
  } catch (error) {
    throw gitFailure(args[0], { status: null, stderr: error.message });
  }
  if (!statuses.includes(result.status)) throw gitFailure(args[0], result);
  return result;
}

/** D4: dry runs use exactly the same read-only eligibility checks, without creating a clone. */
export function inspectRunHistory({ from, git = runGit }) {
  const repository = gitStep(git, from, ['rev-parse', '--show-toplevel'], [0, 128]);
  if (repository.status !== 0) {
    if (/not a git repository/i.test(repository.stderr || '')) return { imported: false, reason: 'not in git' };
    throw gitFailure('rev-parse', repository);
  }
  const top = repository.stdout.trim();
  const prefix = path.relative(top, from).split(path.sep).join('/');
  if (!prefix) return { imported: false, reason: 'store is a repository of its own' };
  const commits = Number(gitStep(git, top, ['rev-list', '--count', 'HEAD', '--', prefix]).stdout.trim());
  if (commits === 0) return { imported: false, reason: 'no history' };
  return { top, prefix, commits };
}

export function importRunHistory({ from, to, git = runGit, tmpdir = os.tmpdir() }) {
  const history = inspectRunHistory({ from, git });
  if (history.imported === false) return history;
  const gitDir = path.join(to, '.git');
  const hadGit = fs.existsSync(gitDir);
  const clone = fs.mkdtempSync(path.join(tmpdir, 'codex-bridge-runs-history-'));
  let initializing = false;
  try {
    gitStep(git, tmpdir, ['clone', '--quiet', '--no-checkout', history.top, clone]);
    // D4: subtree requires the prefix on disk; materialize only that prefix in the disposable clone.
    gitStep(git, clone, ['checkout', '--quiet', 'HEAD', '--', history.prefix]);
    gitStep(git, clone, ['subtree', 'split', '--quiet', `--prefix=${history.prefix}`, '-b', 'codex-runs-history']);
    initializing = true;
    gitStep(git, to, ['init', '--quiet']);
    gitStep(git, to, ['fetch', '--quiet', clone, 'codex-runs-history']);
    // D4: mixed reset imports the index and history while keeping the verified on-disk records.
    gitStep(git, to, ['reset', '--quiet', 'FETCH_HEAD']);
    gitStep(git, to, ['add', '-A']);
    if (gitStep(git, to, ['diff', '--cached', '--quiet'], [0, 1]).status === 1) {
      gitStep(git, to, ['commit', '--quiet', '-m', 'Import run records moved by codex-bridge (Plan_77)']);
    }
    return { imported: true, commits: Number(gitStep(git, to, ['rev-list', '--count', 'HEAD']).stdout.trim()) };
  } catch (error) {
    // D4: roll back only metadata created by this import, never the source repository or records.
    if (initializing && !hadGit) fs.rmSync(gitDir, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(clone, { recursive: true, force: true });
  }
}
