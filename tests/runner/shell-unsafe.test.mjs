/** Guards Plan_42 command-line values before a run folder or paid process can exist. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { parseArgs } from '../../src/home/lib/runner/args.mjs';
import {
  firstShellUnsafeSequence,
  SHELL_UNSAFE_SEQUENCES,
} from '../../src/home/lib/shell-unsafe.mjs';

const RUNNER = fileURLToPath(new URL('../../src/home/lib/run-codex.mjs', import.meta.url));

function fixture(t, task) {
  const root = makeTempTree('shell-unsafe-');
  const repo = path.join(root, 'repo');
  const taskFile = path.join(root, 'task.md');
  fs.mkdirSync(repo);
  fs.writeFileSync(taskFile, task);
  t.after(() => removeTempTree(root));
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

test('the shared predicate and --changeset reject unsafe sequences and accept clean values', () => {
  const reviewArgs = ['--agent', 'codex-review', '--order-id', 'plan-56-changeset'];
  for (const sequence of SHELL_UNSAFE_SEQUENCES) {
    assert.equal(firstShellUnsafeSequence(`left${sequence}right`), sequence);
    assert.throws(() => parseArgs([...reviewArgs, '--changeset', `base:left${sequence}right`]), {
      exitCode: 2,
      message: /--changeset contains forbidden shell sequence/,
    });
  }
  assert.equal(firstShellUnsafeSequence('plan-42_step-2.value'), null);
  assert.equal(firstShellUnsafeSequence('later; first&&'), ';');
  assert.equal(firstShellUnsafeSequence('same||position'), '||');

  // Plan_56 D10 changes only the reviewer flag: preserve each selection and its default without an alias.
  for (const changeset of [undefined, 'uncommitted', 'base:main', 'commit:abc1234']) {
    const opts = parseArgs([...reviewArgs, ...(changeset === undefined ? [] : ['--changeset', changeset])]);
    assert.equal(opts.changeset, changeset ?? 'uncommitted');
    assert.equal(Object.hasOwn(opts, 'mode'), false);
  }
  assert.throws(() => parseArgs([...reviewArgs, '--changeset']), {
    exitCode: 2,
    message: /missing value for --changeset/,
  });
  assert.throws(() => parseArgs([...reviewArgs, '--mode', 'base:main']), {
    exitCode: 2,
    message: /unknown flag: --mode; use --changeset instead/,
  });
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
