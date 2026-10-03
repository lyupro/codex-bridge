/**
 * Writes the evidence a build run leaves of the tree before and after it.
 * The before half was written by the launcher and the after half by the worker, so one artifact pair was
 * named in two files; Plan_60 D3a adds a content baseline and its comparison to both halves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { git, headSha, branchName, worktreeSnapshot } from './git-state.mjs';
import { captureFlagBaseline } from './flag-baseline.mjs';
import { scanRunFlags } from './flag-scan.mjs';

export function writeBuildBefore({ runDir, repoRoot, isGitRepo }) {
  fs.writeFileSync(path.join(runDir, 'head-before.txt'), `${isGitRepo ? headSha(repoRoot) : ''}\n`);
  fs.writeFileSync(path.join(runDir, 'branch-before.txt'), `${isGitRepo ? branchName(repoRoot) : ''}\n`);
  fs.writeFileSync(path.join(runDir, 'git-before.txt'), git(repoRoot, ['-c', 'core.quotepath=false', 'status', '--porcelain']).stdout || '');
  fs.writeFileSync(path.join(runDir, 'state-before.txt'), worktreeSnapshot(repoRoot));
  captureFlagBaseline({ runDir, repoRoot, isGitRepo });
}

export function writeBuildAfter({ runDir, repoRoot, isGitRepo }) {
  fs.writeFileSync(path.join(runDir, 'head-after.txt'), `${isGitRepo ? headSha(repoRoot) : ''}\n`);
  fs.writeFileSync(path.join(runDir, 'branch-after.txt'), `${isGitRepo ? branchName(repoRoot) : ''}\n`);
  fs.writeFileSync(path.join(runDir, 'git-after.txt'), git(repoRoot, ['-c', 'core.quotepath=false', 'status', '--porcelain']).stdout || '');
  fs.writeFileSync(path.join(runDir, 'state-after.txt'), worktreeSnapshot(repoRoot));
  fs.writeFileSync(path.join(runDir, 'diff.stat'), git(repoRoot, ['-c', 'core.quotepath=false', 'diff', '--stat']).stdout || '');
  const scan = scanRunFlags({ runDir, repoRoot });
  fs.writeFileSync(path.join(runDir, 'flags.txt'), scan.text);
  fs.writeFileSync(path.join(runDir, 'flags-coverage.txt'), scan.coverage.gaps.map((gap) => `${gap}\n`).join(''));
}
