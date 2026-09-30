/**
 * Reads the repository a run works in: what the tree looks like, what changed, what is
 * under review.
 *
 * Everything here answers a question about the repository and nothing here decides anything
 * about the run. The launcher takes the "before" answers, the worker takes the "after" ones,
 * and write-meta.mjs compares them — which only works while both halves ask git in exactly
 * the same words, so they ask it here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runsRoot } from './runs-root.mjs';
import { commitNames, diffNames, listUntrackedPaths, numstatRows, porcelainPaths } from './git-paths.mjs';
import { encodeSnapshot } from '../meta/snapshot-format.mjs';

export const MAX_LOG = 256 * 1024 * 1024;

export const git = (repo, args) =>
  spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: MAX_LOG, windowsHide: true });

/**
 * Prefix of the run folders as seen from inside the repository, or null when they live
 * outside it. ~/.claude hosts both the dispatchers and every run folder, so a run against
 * ~/.claude sees the runner's own artifacts as work: one failed with “out-of-scope changes”
 * listing its own git-after.txt. The snapshot has to skip them — they are the measuring
 * instrument, not the measurement.
 */
export function runsPrefixInside(repo) {
  const rel = path.relative(repo, runsRoot());
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return `${rel.split(path.sep).join('/')}/`;
}

/**
 * State of the worktree in terms of actual content, not porcelain letters: line counts
 * per tracked file plus content hashes of untracked ones. A porcelain code stays ` M` when Codex
 * edits an already-modified file, so comparing codes would report "0 files changed" for
 * a run that did real work.
 */
export function worktreeSnapshot(repo) {
  const skip = runsPrefixInside(repo);
  // `--no-renames` because every reader of this snapshot compares paths against a scope: with
  // rename detection on, numstat prints one row spelled `old => new` (or `dir/{a => b}/file`),
  // which is not a path and matches no pattern — an in-scope rename would be judged a stray, and
  // the witness named that token at the orchestrator on 2026-09-20. Without it a rename is a
  // deletion plus an addition: two rows, both real paths, both judged on their own merits.
  // Plan_73 D4 preserves the existing git-failure meaning: no rows from that listing.
  const tracked = (numstatRows(repo) ?? [])
    .filter((row) => !(skip && row.path.startsWith(skip)))
    .map((row) => ({ path: row.path, state: `${row.added}\t${row.deleted}` }));
  const untracked = (listUntrackedPaths(repo) ?? [])
    .filter((file) => !(skip && `${file}/`.startsWith(skip)))
    .map((file) => ({ path: file, state: untrackedState(path.join(repo, file)) }));
  return encodeSnapshot([...tracked, ...untracked]);
}

/**
 * Size plus sha256 of an untracked file, read in chunks so a large one does not have to fit in
 * memory. A file that vanished after listing is `missing`; one that cannot be read (on Windows a
 * file held by another process) is `unreadable` rather than an exception that stops the run.
 */
function untrackedState(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    for (let read; (read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0; bytes += read) {
      hash.update(chunk.subarray(0, read));
    }
    return `U\t${bytes}:${hash.digest('hex')}`;
  } catch (error) {
    return error.code === 'ENOENT' ? 'U\tmissing' : 'U\tunreadable';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The commit a run starts and ends on. A delegated run is forbidden to commit — the
 * orchestrator has to see the edits uncommitted in order to accept them — and comparing
 * HEAD either side is the only way to know whether that held. Empty for a repo without
 * commits, which write-meta.mjs reads as "nothing to compare", not as a violation.
 */
export const headSha = (repo) => (git(repo, ['rev-parse', 'HEAD']).stdout || '').trim();

/**
 * The branch a run starts and ends on. Empty means detached HEAD, which is data to compare,
 * not an error: a run may begin detached and stay that way, or leave the repository detached.
 */
export const branchName = (repo) =>
  (git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout || '').trim();

const FAKE_DONE_RE =
  /TODO|FIXME|test\.(skip|only)|it\.(skip|only)|describe\.(skip|only)|NotImplemented/;

/**
 * Traces of fake completion. `git diff` carries nothing for untracked files, so a brand
 * new file full of TODOs would otherwise pass as "Flags: none" — the one case the check
 * exists for.
 */
export function findFakeDone(repo) {
  const skip = runsPrefixInside(repo);
  const hits = (git(repo, ['diff', '-U0']).stdout || '')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('+') && FAKE_DONE_RE.test(l));
  for (const file of (listUntrackedPaths(repo) ?? [])
    // Same reason as in worktreeSnapshot: inside ~/.claude the run folder is part of the
    // worktree, and task.md spells out the very words this scans for ("do not leave TODOs,
    // test.skip"). A run flagged itself for quoting its own instructions.
    .filter((file) => !(skip && `${file}/`.startsWith(skip)))) {
    const full = path.join(repo, file);
    try {
      if (fs.statSync(full).size > 1024 * 1024) continue;
      fs.readFileSync(full, 'utf8')
        .split(/\r?\n/)
        .forEach((l, i) => {
          if (FAKE_DONE_RE.test(l)) hits.push(`${file}:${i + 1}: ${l.trim()}`);
        });
    } catch {
      // Binary or unreadable: nothing to flag.
    }
  }
  return hits.length ? `${hits.slice(0, 20).join('\n')}\n` : '';
}

/** What exactly is under review, resolved from git rather than from wording. */
export function reviewScope(repo, changeset) {
  if (changeset.startsWith('base:')) {
    const base = changeset.slice(5);
    return {
      label: `branch changes against base ${base}`,
      diffCommand: `git diff ${base}...HEAD`,
      files: diffNames(repo, `${base}...HEAD`) ?? [],
    };
  }
  if (changeset.startsWith('commit:')) {
    const sha = changeset.slice(7);
    return {
      label: `commit ${sha}`,
      diffCommand: `git show ${sha}`,
      files: commitNames(repo, sha) ?? [],
    };
  }
  return {
    label: 'uncommitted changes (staged, unstaged, untracked)',
    diffCommand: 'git status --porcelain && git diff HEAD',
    files: porcelainPaths(repo) ?? [],
  };
}
