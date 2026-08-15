/** Guards Plan_42 command-line values before a run folder or paid process can exist. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  firstShellUnsafeSequence,
  SHELL_UNSAFE_SEQUENCES,
} from '../../src/home/lib/shell-unsafe.mjs';

const RUNNER = fileURLToPath(new URL('../../src/home/lib/run-codex.mjs', import.meta.url));

function fixture(t, task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-unsafe-'));
  const repo = path.join(root, 'repo');
  const taskFile = path.join(root, 'task.md');
  fs.mkdirSync(repo);
  fs.writeFileSync(taskFile, task);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, taskFile };
}

function run({ root, repo, taskFile }, orderId) {
  return spawnSync(process.execPath, [
    RUNNER,
    '--agent', 'codex-scout',
    '--repo', repo,
    '--order-id', orderId,
    '--scope', 'C:/absolute-is-refused',
    '--task-file', taskFile,
  ], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CODEX_RUNS_ROOT: path.join(root, 'runs') },
  });
}

test('the shared predicate names every forbidden sequence and accepts clean text', () => {
  for (const sequence of SHELL_UNSAFE_SEQUENCES) {
    assert.equal(firstShellUnsafeSequence(`left${sequence}right`), sequence);
  }
  assert.equal(firstShellUnsafeSequence('plan-42_step-2.value'), null);
  assert.equal(firstShellUnsafeSequence('later; first&&'), ';');
  assert.equal(firstShellUnsafeSequence('same||position'), '||');
});

test('an unsafe order id is refused before its run folder exists', (t) => {
  const context = fixture(t, 'Ordinary task text.');
  const result = run(context, 'plan-42;unsafe');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--order-id contains forbidden shell sequence ";"/);
  assert.match(result.stderr, /put free text in the task file/);
  assert.equal(fs.existsSync(path.join(context.root, 'runs')), false);
});

test('the same unsafe prose is accepted inside the task file', (t) => {
  const context = fixture(
    t,
    '## Task\nExplain `code`, $(syntax), ${values}, a && b || c | d; all as prose.\n## Questions\n- Why?',
  );
  const result = run(context, 'plan-42-safe-task-file');
  assert.equal(result.status, 2, result.stderr);
  assert.doesNotMatch(result.stderr, /forbidden shell sequence/);
  assert.match(result.stderr, /--scope pattern/);
});
