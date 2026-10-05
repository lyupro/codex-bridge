/** Guards task-file/stdin selection before a run folder or paid process can exist. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { makeHomeImage } from '../home-image.mjs';
import { orderInvocation, orderTaskText } from './order-invocation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'src', 'home', 'lib', 'run-codex.mjs');
const BIN = path.join(ROOT, 'bin', 'codex-bridge.mjs');

function fixture(t) {
  const root = makeTempTree('task-input-');
  t.after(() => removeTempTree(root));
  return root;
}

function args(repo, taskFile) {
  // raw argv: task-channel tests need literal paths, missing files, and absent --task-file.
  return [
    '--agent', 'codex-review', '--repo', repo, '--order-id', 'task-input',
    '--scope', 'C:/absolute-is-refused', ...(taskFile ? ['--task-file', taskFile] : []),
  ];
}

function run(entry, argv, root, input, extraEnv = {}) {
  return spawnSync(process.execPath, [entry, ...argv], {
    cwd: root,
    encoding: 'utf8',
    input,
    windowsHide: true,
    env: { ...process.env, CODEX_RUNS_ROOT: path.join(root, 'runs'), ...extraEnv },
  });
}

test('--task-file reads a non-empty task before later runner validation', (t) => {
  const root = fixture(t);
  const taskFile = path.join(root, 'task.md');
  fs.writeFileSync(taskFile, 'task from file\n');
  // raw argv: this case tests reading the explicit --task-file channel.
  const result = run(RUNNER, args(root, taskFile), root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--scope pattern/);
  assert.doesNotMatch(result.stderr, /task file.*empty|stdin is empty/);
});

test('missing and empty task files name the task-file channel', (t) => {
  const root = fixture(t);
  const empty = path.join(root, 'empty.md');
  fs.writeFileSync(empty, ' \n');
  // raw argv: the task-file path deliberately does not exist.
  const missingResult = run(RUNNER, args(root, path.join(root, 'missing.md')), root);
  assert.equal(missingResult.status, 2);
  assert.match(missingResult.stderr, /task file from --task-file could not be read/);
  // raw argv: the task file deliberately contains only whitespace.
  const emptyResult = run(RUNNER, args(root, empty), root);
  assert.equal(emptyResult.status, 2);
  assert.match(emptyResult.stderr, /task file from --task-file is empty/);
});

test('--task-file refuses relative paths with the received value', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'task.md'), 'wrong task from cwd\n');
  // raw argv: the task-file path must remain relative to test its refusal.
  const result = run(RUNNER, args(root, 'task.md'), root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--task-file must be an absolute path; got "task\.md"/);
});

test('stdin remains the fallback and an empty stdin names that channel', (t) => {
  const root = fixture(t);
  // raw argv: the fallback channel must have no --task-file.
  const accepted = run(RUNNER, args(root), root, orderTaskText({ task: 'task from stdin' }));
  assert.equal(accepted.status, 2);
  assert.match(accepted.stderr, /--scope pattern/);
  // raw argv: empty stdin must remain empty and have no --task-file.
  const empty = run(RUNNER, args(root), root, '');
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /task text on stdin is empty/);
});

test('non-empty stdin and --task-file refuse instead of choosing precedence', (t) => {
  const root = fixture(t);
  const taskFile = path.join(root, 'task.md');
  fs.writeFileSync(taskFile, 'task from file\n');
  // raw argv: both input channels deliberately provide non-empty task text.
  const result = run(RUNNER, args(root, taskFile), root, 'task from stdin\n');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /both stdin and --task-file/);
});

test('the direct file and package run command share task-channel output and exit code', async (t) => {
  const root = fixture(t);
  const taskFile = path.join(root, 'empty.md');
  fs.writeFileSync(taskFile, '');
  // raw argv: both entry points must receive the same deliberately empty task file.
  const argv = args(root, taskFile);
  const direct = run(RUNNER, argv, root);
  const command = run(BIN, ['run', ...argv], root, undefined, { CODEX_BRIDGE_HOME: await makeHomeImage(t) });
  assert.equal(command.status, direct.status);
  assert.equal(command.stdout, direct.stdout);
  assert.equal(command.stderr, direct.stderr);
});

test('the direct file and package run command share the runner crash reply and exit code', async (t) => {
  const root = fixture(t);
  const runsRootFile = path.join(root, 'runs-root-file');
  fs.writeFileSync(runsRootFile, 'not a directory\n');
  const { argv } = orderInvocation({
    agent: 'codex-review', order: { repository: root, 'order id': 'crash-check' },
    task: 'force launcher crash', dir: root,
  });
  const env = { ...process.env, CODEX_RUNS_ROOT: runsRootFile };
  const direct = spawnSync(process.execPath, [RUNNER, ...argv], { cwd: root, encoding: 'utf8', windowsHide: true, env });
  const command = spawnSync(process.execPath, [BIN, 'run', ...argv], {
    cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...env, CODEX_BRIDGE_HOME: await makeHomeImage(t) },
  });
  assert.equal(direct.status, 1);
  assert.equal(command.status, direct.status);
  assert.equal(command.stdout, direct.stdout);
  assert.match(command.stdout, /^FAIL — Codex runner crashed before creating the run folder:/);
  assert.equal(command.stderr, direct.stderr);
});

test('a malformed scout marker refuses before any run folder or quota is spent', (t) => {
  const root = fixture(t);
  const { argv } = orderInvocation({
    agent: 'codex-scout', order: { repository: root, 'order id': 'bad-marker' },
    task: 'Scout the startup context.', questions: ['[Context-Only] What were you handed?'], dir: root,
  });
  const result = run(RUNNER, argv, root);
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Q1/);
  assert.match(result.stderr, /\[context-only\]/);
  assert.match(result.stderr, /no quota was spent/);
  assert.equal(fs.existsSync(path.join(root, 'runs')), false);
});
