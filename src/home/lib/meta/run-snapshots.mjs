/**
 * Read a run's before/after snapshots and compare them strictly.
 * On 2026-09-30 git-quoted Cyrillic names made an in-scope edit look out of scope;
 * missing or untrustworthy snapshots must refuse judgement, never imply a clean tree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { compareSnapshots } from './snapshot-format.mjs';

export function readSnapshot(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function runSnapshotChanges(runDir) {
  return compareSnapshots(
    readSnapshot(path.join(runDir, 'state-before.txt')),
    readSnapshot(path.join(runDir, 'state-after.txt')),
  );
}

export function snapshotRefusal(comparison) {
  const issue = comparison.side ? `${comparison.side} ${comparison.issue}` : comparison.issue;
  return `worktree snapshots cannot be compared (${issue}): ${comparison.detail}`;
}
