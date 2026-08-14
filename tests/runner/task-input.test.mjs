/** Guards task-file/stdin selection before a run folder or paid process can exist. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'src', 'home', 'lib', 'run-codex.mjs');
const BIN = path.join(ROOT, 'bin', 'codex-bridge.mjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function args(repo, taskFile) {
  return [
    '--agent', 'codex-review', '--repo', repo, '--order-id', 'task-input',
    '--scope', 'C:/absolute-is-refused', ...(taskFile ? ['--task-file', taskFile] : []),
  ];
}

function run(entry, argv, root, input) {
  return spawnSync(process.execPath, [entry, ...argv], {
    cwd: root,
    encoding: 'utf8',
    input,
    env: { ...process.env, CODEX_RUNS_ROOT: path.join(root, 'runs') },
  });
}

test('--task-file reads a non-empty task before later runner validation', (t) => {
  const root = fixture(t);
  const taskFile = path.join(root, 'task.md');
  fs.writeFileSync(taskFile, 'task from file\n');
  const result = run(RUNNER, args(root, taskFile), root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--scope pattern/);
  assert.doesNotMatch(result.stderr, /task file.*empty|stdin is empty/);
});

test('missing and empty task files name the task-file channel', (t) => {
  const root = fixture(t);
  const empty = path.join(root, 'empty.md');
  fs.writeFileSync(empty, ' \n');
  const missingResult = run(RUNNER, args(root, path.join(root, 'missing.md')), root);
  assert.equal(missingResult.status, 2);
  assert.match(missingResult.stderr, /task file from --task-file could not be read/);
  const emptyResult = run(RUNNER, args(root, empty), root);
  assert.equal(emptyResult.status, 2);
  assert.match(emptyResult.stderr, /task file from --task-file is empty/);
});

test('stdin remains the fallback and an empty stdin names that channel', (t) => {
  const root = fixture(t);
  const accepted = run(RUNNER, args(root), root, 'task from stdin\n');
  assert.equal(accepted.status, 2);
  assert.match(accepted.stderr, /--scope pattern/);
  const empty = run(RUNNER, args(root), root, '');
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /task text on stdin is empty/);
});

test('non-empty stdin and --task-file refuse instead of choosing precedence', (t) => {
  const root = fixture(t);
  const taskFile = path.join(root, 'task.md');
  fs.writeFileSync(taskFile, 'task from file\n');
  const result = run(RUNNER, args(root, taskFile), root, 'task from stdin\n');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /both stdin and --task-file/);
});

test('the direct file and package run command share task-channel output and exit code', (t) => {
  const root = fixture(t);
  const taskFile = path.join(root, 'empty.md');
  fs.writeFileSync(taskFile, '');
  const argv = args(root, taskFile);
  const direct = run(RUNNER, argv, root);
  const command = run(BIN, ['run', ...argv], root);
  assert.equal(command.status, direct.status);
  assert.equal(command.stdout, direct.stdout);
  assert.equal(command.stderr, direct.stderr);
});
