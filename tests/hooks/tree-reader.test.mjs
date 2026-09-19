/**
 * A hook never asks git what changed in the worktree; it reads the run's recorded snapshot
 * and the helpers in git-state.mjs. This is structural because the witness drifted from the
 * verdict for months, surfacing only as a false accusation against an honest run on 2026-09-19.
 * Match literal argument lists, not prose: worktree-lock explains git status --porcelain
 * in a comment without using it to measure changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = fileURLToPath(new URL('../../src/home/hooks/', import.meta.url));
const READERS = [
  /(?:\[|,)\s*['"`]status['"`]\s*,\s*['"`]--porcelain(?:=[^'"`]+)?['"`]/,
  /(?:\[|,)\s*['"`]ls-files['"`]\s*,\s*['"`](?:-o|--others)['"`]/,
  /(?:\[|,)\s*['"`]--numstat['"`]\s*(?:,|\])/,
];

async function hookFiles(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await hookFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(file);
  }
  return files;
}

test('hooks use the shared tree reader instead of raw worktree queries', async () => {
  const violations = [];
  for (const file of await hookFiles(HOOKS)) {
    const source = await fs.readFile(file, 'utf8');
    if (READERS.some((reader) => reader.test(source))) violations.push(path.relative(HOOKS, file));
  }
  assert.deepEqual(violations, [], `Raw worktree query in hook(s): ${violations.join(', ')}`);
});

// The guard must catch each forbidden argument list without banning incident explanations.
test('the tree-reader guard matches commands as arguments, not prose', () => {
  for (const command of [
    "['status', '--porcelain']",
    '["-C", repo, "status", "--porcelain=v1"]',
    "['ls-files', '-o', '--exclude-standard']",
    "['ls-files',\n '--others']",
    "['diff', 'HEAD', '--numstat']",
    '[`diff`, `--numstat`, `HEAD`]',
  ]) assert.ok(READERS.some((reader) => reader.test(command)), command);
  for (const prose of [
    '// git status --porcelain reports status codes.',
    '/* git ls-files -o and git ls-files --others list untracked files. */',
    '// git diff --numstat counts lines.',
  ]) assert.ok(READERS.every((reader) => !reader.test(prose)), prose);
});
