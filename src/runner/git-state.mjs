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
import { runsRoot } from './runs-root.mjs';

export const MAX_LOG = 256 * 1024 * 1024;

export const git = (repo, args) =>
  spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: MAX_LOG });

/**
 * Prefix of the run folders as seen from inside the repository, or null when they live
 * outside it. ~/.claude hosts both the dispatchers and every run folder, so a run against
 * ~/.claude sees the runner's own artifacts as work: one failed with «правки вне объёма»
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
 * per tracked file plus sizes of untracked ones. A porcelain code stays ` M` when Codex
 * edits an already-modified file, so comparing codes would report "0 files changed" for
 * a run that did real work.
 */
export function worktreeSnapshot(repo) {
  const skip = runsPrefixInside(repo);
  // The path is the third tab-separated field in both git outputs used here.
  const mine = (line) => Boolean(skip) && (line.split('\t')[2] || '').startsWith(skip);
  const tracked = (git(repo, ['diff', 'HEAD', '--numstat']).stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !mine(line))
    .join('\n')
    .trim();
  const untracked = (git(repo, ['ls-files', '-o', '--exclude-standard']).stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => !(skip && `${file}/`.startsWith(skip)))
    .map((file) => {
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(repo, file)).size;
      } catch {
        // Vanished between listing and stat: size 0 still marks it as present.
      }
      return `U\t${bytes}\t${file}`;
    });
  return [tracked, untracked.join('\n')].filter(Boolean).join('\n');
}

/**
 * The commit a run starts and ends on. A delegated run is forbidden to commit — the
 * orchestrator has to see the edits uncommitted in order to accept them — and comparing
 * HEAD either side is the only way to know whether that held. Empty for a repo without
 * commits, which write-meta.mjs reads as "nothing to compare", not as a violation.
 */
export const headSha = (repo) => (git(repo, ['rev-parse', 'HEAD']).stdout || '').trim();

const FAKE_DONE_RE =
  /TODO|FIXME|test\.(skip|only)|it\.(skip|only)|describe\.(skip|only)|NotImplemented/;

/**
 * Traces of fake completion. `git diff` carries nothing for untracked files, so a brand
 * new file full of TODOs would otherwise pass as "Флаги: нет" — the one case the check
 * exists for.
 */
export function findFakeDone(repo) {
  const skip = runsPrefixInside(repo);
  const hits = (git(repo, ['diff', '-U0']).stdout || '')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('+') && FAKE_DONE_RE.test(l));
  for (const file of (git(repo, ['ls-files', '-o', '--exclude-standard']).stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    // Same reason as in worktreeSnapshot: inside ~/.claude the run folder is part of the
    // worktree, and task.md spells out the very words this scans for ("не оставляй TODO,
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
export function reviewScope(repo, mode) {
  if (mode.startsWith('base:')) {
    const base = mode.slice(5);
    return {
      label: `изменения ветки против базы ${base}`,
      diffCommand: `git diff ${base}...HEAD`,
      files: (git(repo, ['diff', '--name-only', `${base}...HEAD`]).stdout || '')
        .split(/\r?\n/)
        .filter(Boolean),
    };
  }
  if (mode.startsWith('commit:')) {
    const sha = mode.slice(7);
    return {
      label: `коммит ${sha}`,
      diffCommand: `git show ${sha}`,
      files: (git(repo, ['show', '--name-only', '--format=', sha]).stdout || '')
        .split(/\r?\n/)
        .filter(Boolean),
    };
  }
  return {
    label: 'незакоммиченные правки (staged, unstaged, untracked)',
    diffCommand: 'git status --porcelain && git diff HEAD',
    files: (git(repo, ['status', '--porcelain']).stdout || '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.slice(3).trim()),
  };
}
