/** Guards Plan_42 command-line values before a run folder or paid process can exist. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { parseArgs } from '../../src/home/lib/runner/args.mjs';
import { orderInvocation } from './order-invocation.mjs';
import { launcherProcessMocks } from './launcher-mocks.mjs';
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

function run({ root, repo }, argv) {
  // raw argv: the executable path wraps helper-generated transport arguments only.
  return spawnSync(process.execPath, [RUNNER, ...argv], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CODEX_RUNS_ROOT: path.join(root, 'runs') },
  });
}

function headerOptions(context, changeset, launch = false) {
  const { argv } = orderInvocation({
    agent: 'codex-review',
    order: { 'order id': 'plan-56-changeset', ...(changeset === undefined ? {} : { changeset }) },
    dir: context.root,
  });
  const argsModule = new URL('../../src/home/lib/runner/args.mjs', import.meta.url).href;
  const taskInput = new URL('../../src/home/lib/runner/task-input.mjs', import.meta.url).href;
  const launcher = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;
  const mocks = launcherProcessMocks({ worker: 'spawn', probe: 'marker' });
  const source = `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
${mocks}
syncBuiltinESMExports();
import { parseArgs } from ${JSON.stringify(argsModule)};
import { settleTaskInput } from ${JSON.stringify(taskInput)};
try {
  const argv = JSON.parse(process.env.CODEX_TEST_ARGV);
  if (${launch}) {
    // raw argv: the mock launcher receives helper-generated transport arguments only.
    process.argv = [process.execPath, ${JSON.stringify(launcher)}, ...argv];
    const { launcher } = await import(${JSON.stringify(launcher)});
    const code = await launcher();
    if (code !== undefined) process.exitCode = code;
  } else {
    const opts = parseArgs(argv);
    settleTaskInput(opts);
    process.stdout.write(JSON.stringify(opts));
  }
} catch (err) { process.exitCode = err.exitCode || 1; }`;
  // raw argv: Node isolates input settlement from the suite's interactive stdin.
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', env: { ...process.env, CODEX_TEST_ARGV: JSON.stringify(argv),
      CODEX_RUNS_ROOT: path.join(context.root, 'runs') },
  });
  return { code: out.status, stderr: out.stderr, opts: !launch && out.stdout ? JSON.parse(out.stdout) : null };
}

test('the shared predicate and changeset header reject unsafe sequences', async (t) => {
  for (const sequence of SHELL_UNSAFE_SEQUENCES) {
    assert.equal(firstShellUnsafeSequence(`left${sequence}right`), sequence);
    await t.test(`changeset refuses ${JSON.stringify(sequence)}`, (child) => {
      const context = fixture(child, 'Inspect changes.');
      const { code, stderr } = headerOptions(context, `base:left${sequence}right`, true);
      assert.equal(code, 2, stderr);
      assert.match(stderr, /`changeset:` contains forbidden shell sequence/);
      assert.equal(fs.existsSync(path.join(context.root, 'runs')), false);
    });
  }
  assert.equal(firstShellUnsafeSequence('plan-42_step-2.value'), null);
  assert.equal(firstShellUnsafeSequence('later; first&&'), ';');
  assert.equal(firstShellUnsafeSequence('same||position'), '||');
});

test('changeset header selections and the omitted-value default are preserved', (t) => {
  const context = fixture(t, 'Inspect changes.');
  // Plan_56 D10 selections and the omitted-value default survive the Plan_63 D8 channel switch.
  for (const changeset of [undefined, 'uncommitted', 'base:main', 'commit:abc1234']) {
    const { code, opts, stderr } = headerOptions(context, changeset);
    assert.equal(code, 0, stderr);
    assert.equal(opts.changeset, changeset ?? 'uncommitted');
    assert.equal(Object.hasOwn(opts, 'mode'), false);
  }
});

test('the changeset and obsolete mode flags are closed without an alias', () => {
  for (const flag of ['--changeset', '--mode']) {
    // raw argv: each closed flag must be refused before any legacy value parsing or aliasing.
    assert.throws(() => parseArgs(['--agent', 'codex-review', flag]), {
      exitCode: 2, message: new RegExp('unknown flag ' + flag + ':'),
    });
  }
});

test('an unsafe order id is refused before its run folder exists', (t) => {
  const context = fixture(t, 'Ordinary task text.');
  const { argv } = orderInvocation({
    agent: 'codex-build',
    order: { repository: context.repo, 'order id': 'plan-42;unsafe', scope: 'C:/absolute-is-refused' },
    advice: 'mechanical', questions: ['Why?'], dir: context.root,
  });
  const result = run(context, argv);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /`order id:` contains forbidden shell sequence ";"/);
  assert.match(result.stderr, /put free text in the task file/);
  assert.equal(fs.existsSync(path.join(context.root, 'runs')), false);
});

test('the same unsafe prose is accepted inside the task file', (t) => {
  const context = fixture(
    t,
    '## Task\nExplain `code`, $(syntax), ${values}, a && b || c | d; all as prose.\n## Questions\n- Why?',
  );
  const { argv } = orderInvocation({
    agent: 'codex-build',
    order: { repository: context.repo, 'order id': 'plan-42-safe-task-file', scope: 'C:/absolute-is-refused' },
    advice: 'mechanical', task: 'Explain `code`, $(syntax), ${values}, a && b || c | d; all as prose.',
    questions: ['Why?'], dir: context.root,
  });
  const result = run(context, argv);
  assert.equal(result.status, 2, result.stderr);
  assert.doesNotMatch(result.stderr, /forbidden shell sequence/);
  assert.match(result.stderr, /`scope:` pattern/);
});
