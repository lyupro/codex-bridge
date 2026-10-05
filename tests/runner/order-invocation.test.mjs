/** Guards Plan_63 D5/D8's shared header-only order-to-invocation boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import {
  ALL_ORDER_LABELS, ORDER_AGENTS, orderInputName, orderFromHeader, renderOrderHeaderHelp,
} from '../../src/home/lib/order-schema.mjs';
import { parseTaskHeader } from '../../src/home/lib/task-header.mjs';
import { parseArgs, RunnerUsageError } from '../../src/home/lib/runner/args.mjs';
import { orderInvocation, orderTaskText } from './order-invocation.mjs';

function fixture(t) {
  const dir = makeTempTree('order-invocation-');
  t.after(() => removeTempTree(dir));
  return dir;
}

// Plan_63 D8: exercise the stdin boundary without replacing the host process's stdin.
function settle(argv, input, launch = false) {
  const argsUrl = new URL('../../src/home/lib/runner/args.mjs', import.meta.url).href;
  const inputUrl = new URL('../../src/home/lib/runner/task-input.mjs', import.meta.url).href;
  const launcherUrl = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;
  const script = `
    import { parseArgs } from ${JSON.stringify(argsUrl)};
    import { settleTaskInput } from ${JSON.stringify(inputUrl)};
    try {
      const argv = JSON.parse(process.argv[1]);
      if (${launch}) {
        const { launcher } = await import(${JSON.stringify(launcherUrl)});
        await launcher(argv);
      } else {
        const opts = parseArgs(argv);
        const document = settleTaskInput(opts, { cwd: process.cwd() });
        console.log(JSON.stringify({ opts, ...document }));
      }
    } catch (error) { process.exitCode = error.exitCode ?? 1; }
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(argv)],
    { input, encoding: 'utf8' });
}

function usageRefusal(argv, pattern) {
  assert.throws(() => parseArgs(argv), (error) => {
    assert.ok(error instanceof RunnerUsageError);
    assert.equal(error.exitCode, 2);
    assert.match(error.message, pattern);
    return true;
  });
}

test('one task file has adjacent order, advice, and grant headers before document sections', (t) => {
  const dir = fixture(t);
  const options = {
    agent: 'codex-build', order: { scope: 'src/**', 'order id': 'plan-63' }, advice: 'mechanical',
    grant: { kind: 'continue', run: 'prior-run', reason: 'finish verification' },
    task: 'Build it.', questions: ['Why?', 'How?'], verify: 'npm test',
  };
  const { taskFile } = orderInvocation({ ...options, dir });
  const expected = 'order id: plan-63\nscope: src/**\nadvice: mechanical\ncontinue: prior-run — finish verification\n\n'
    + '## Task\nBuild it.\n\n## Questions\n- Why?\n- How?\n\n## Verify\nnpm test\n';
  assert.equal(fs.readFileSync(taskFile, 'utf8'), expected);
  assert.equal(orderTaskText(options), expected);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(taskFile)]);
});

test('argv contains only transport flags and given labels appear in schema order in the header', (t) => {
  const dir = fixture(t);
  const order = {
    slug: 'probe', 'scope new': 'src/new.mjs', scope: 'src/existing.mjs', repository: dir,
    phase: 'default', 'order id': 'order-63', effort: 'medium', changeset: 'uncommitted',
  };
  const { argv, taskFile } = orderInvocation({ agent: 'codex-build', order, dir });
  assert.equal(path.isAbsolute(taskFile), true);
  assert.equal(path.dirname(taskFile), dir);
  assert.deepEqual(argv, ['--agent', 'codex-build', '--task-file', taskFile]);
  const expected = ALL_ORDER_LABELS.filter((label) => Object.hasOwn(order, label))
    .map((label) => `${label}: ${order[label]}`).join('\n') + '\n\n## Task\nInspect the repository.\n';
  assert.equal(fs.readFileSync(taskFile, 'utf8'), expected);
  assert.equal(orderTaskText({ order }), expected);
});

test('omitted labels and optional sections add nothing and task has its documented default', (t) => {
  const dir = fixture(t);
  const { argv, taskFile } = orderInvocation({ agent: 'codex-review', dir });
  assert.deepEqual(argv, ['--agent', 'codex-review', '--task-file', taskFile]);
  assert.equal(fs.readFileSync(taskFile, 'utf8'), '## Task\nInspect the repository.\n');
  const partial = orderInvocation({ agent: 'codex-review', dir, order: { 'order id': 'partial' }, task: '' });
  assert.deepEqual(partial.argv, ['--agent', 'codex-review', '--task-file', partial.taskFile]);
  assert.equal(fs.readFileSync(partial.taskFile, 'utf8'), 'order id: partial\n\n## Task\n\n');
});

test('continue and retry grants add only their header and no continuation flag', (t) => {
  const dir = fixture(t);
  for (const kind of ['continue', 'retry']) {
    const { argv, taskFile } = orderInvocation({
      agent: 'codex-build', dir, grant: { kind, run: 'prior-run', reason: 'finish it' },
    });
    assert.deepEqual(argv, ['--agent', 'codex-build', '--task-file', taskFile]);
    assert.equal(fs.readFileSync(taskFile, 'utf8'), `${kind}: prior-run — finish it\n\n## Task\nInspect the repository.\n`);
  }
});

test('unknown order keys throw before a task file is written, including for stdin text', (t) => {
  const dir = fixture(t);
  const options = { agent: 'codex-build', order: { unknown: 'value' }, dir };
  assert.throws(() => orderInvocation(options), /Unknown order input label "unknown"/);
  assert.throws(() => orderTaskText(options), /Unknown order input label "unknown"/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('required invocation inputs, plain orders, and complete grants fail loudly', (t) => {
  const dir = fixture(t);
  assert.throws(() => orderInvocation({ dir }), /agent is required/);
  assert.throws(() => orderInvocation({ agent: 'codex-build', dir: 'relative' }), /absolute directory/);
  for (const order of [null, [], new Map()]) {
    assert.throws(() => orderInvocation({ agent: 'codex-build', dir, order }), /plain object/);
  }
  for (const grant of [{ kind: 'other', run: 'prior', reason: 'finish' }, { kind: 'continue' }]) {
    assert.throws(() => orderInvocation({ agent: 'codex-build', dir, grant }), /grant requires/);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('order input names use backticked header spellings, including retry', () => {
  for (const label of ALL_ORDER_LABELS) assert.equal(orderInputName(label), '`' + label + ':`');
});

test('every old order flag and every unknown flag refuses with header help for a known agent', (t) => {
  t.mock.method(console, 'error', () => {});
  for (const flag of ['order-id', 'scope', 'scope-new', 'repo', 'slug', 'effort', 'changeset',
    'phase', 'continue', 'question', 'verify', 'mode', 'unknown']) {
    for (const argv of [['--agent', 'codex-build', `--${flag}`], [`--${flag}`, '--agent', 'codex-build']]) {
      assert.throws(() => parseArgs(argv), (error) => {
        assert.equal(error.exitCode, 2);
        assert.equal(error.message, `unknown flag --${flag}: codex-bridge run takes only --agent, --task-file and --no-wait; `
          + 'the order belongs in the task-file header\n' + renderOrderHeaderHelp('codex-build'));
        return true;
      });
    }
  }
  usageRefusal(['--agent', 'unknown-agent', '--unknown'], /unknown flag --unknown/);
  usageRefusal(['--unknown'], /the order belongs in the task-file header$/);
});

test('transport arguments retain required values, strict no-wait spellings, and shell safety', (t) => {
  t.mock.method(console, 'error', () => {});
  const argv = ['--agent', 'codex-build'];
  assert.deepEqual(parseArgs(argv), { agent: 'codex-build', noWait: false });
  assert.equal(parseArgs([...argv, '--no-wait']).noWait, true);
  for (const spelling of ['1', 'true', 'yes', 'TRUE', 'YES']) {
    assert.equal(parseArgs([...argv, '--no-wait', spelling]).noWait, true);
  }
  for (const spelling of ['0', 'false', 'no', 'FALSE', 'NO']) {
    assert.equal(parseArgs([...argv, '--no-wait', spelling]).noWait, false);
  }
  usageRefusal([...argv, '--no-wait', 'placeholder'], /takes no value/);
  usageRefusal([], /--agent is required/);
  usageRefusal(['--agent', 'unknown-agent'], /unknown --agent/);
  usageRefusal(['--agent'], /missing value/);
  usageRefusal([...argv, '--task-file', '--no-wait'], /missing value/);
  usageRefusal([...argv, 'bare'], /unexpected argument/);
  for (const flag of ['agent', 'task-file']) {
    usageRefusal([...argv, `--${flag}`, 'unsafe;value'], /forbidden shell sequence/);
  }
});

test('the same order settles from a task file and stdin with only document questions and verify', (t) => {
  const dir = fixture(t);
  const options = { agent: 'codex-build', order: {
    'order id': 'plan-63-input', repository: dir, scope: 'src/**', effort: 'none', slug: 'chosen',
  }, task: 'Inspect it.', questions: ['[context-only] What exists?'], verify: 'npm test' };
  const { argv } = orderInvocation({ ...options, dir });
  const fromFile = settle(argv, '');
  const fromStdin = settle(['--agent', options.agent], orderTaskText(options));
  for (const result of [fromFile, fromStdin]) {
    assert.equal(result.status, 0, result.stderr);
    const { opts, task, header } = JSON.parse(result.stdout);
    assert.equal(opts.orderId, 'plan-63-input');
    assert.equal(opts.repo, dir);
    assert.equal(opts.slug, 'chosen');
    assert.equal(opts.effort, 'none');
    assert.deepEqual(opts.scopePatterns, ['src/**']);
    assert.deepEqual(opts.scopeNewPatterns, []);
    assert.deepEqual(opts.questions, options.questions);
    assert.equal(opts.verify, options.verify);
    assert.equal(opts.continue, false);
    assert.equal(task.trim(), 'Inspect it.');
    assert.equal(header.fields['order id'], opts.orderId);
  }
  const both = settle(argv, orderTaskText(options));
  assert.equal(both.status, 2);
  assert.match(both.stderr, /both stdin and --task-file/);
});

test('header grants alone set continuation and refuse no-wait for both grant kinds', () => {
  for (const kind of ['continue', 'retry']) {
    const text = orderTaskText({ order: { 'order id': 'plan-63' },
      grant: { kind, run: 'prior', reason: 'finish it' } });
    const allowed = settle(['--agent', 'codex-review'], text);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(JSON.parse(allowed.stdout).opts.continue, true);
    const refused = settle(['--agent', 'codex-review', '--no-wait'], text);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, new RegExp(`--no-wait cannot be combined with a \`${kind}:\` grant: ` +
      'checking an existing run must never authorize a new one'));
  }
});

test('header and normalization problems refuse before phase resolution in the launcher', () => {
  // Plan_63 D8: a bad header/options must win over an undeclared phase before any paid probe.
  for (const [order, pattern] of [
    [{ phase: 'undeclared-phase' }, /missing required header label "order id:"/],
    [{ 'order id': 'plan-63', phase: 'undeclared-phase', effort: 'two words' }, /`effort:` must be a non-empty single word/],
  ]) {
    const result = settle(['--agent', 'codex-advisor'], orderTaskText({ order }), true);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, pattern);
    assert.doesNotMatch(result.stderr, /undeclared `phase:`/);
  }
  const result = settle(['--agent', 'codex-advisor', '--no-wait'], orderTaskText({
    order: { 'order id': 'plan-63', phase: 'undeclared-phase' },
    grant: { kind: 'retry', run: 'prior', reason: 'finish it' },
  }), true);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--no-wait cannot be combined/);
  assert.doesNotMatch(result.stderr, /undeclared `phase:`/);
});

test('header problems print one per line followed by help and keep required order/scope boundaries', () => {
  const result = settle(['--agent', 'codex-build'], orderTaskText({
    order: { 'scope new': 'new.mjs' }, advice: 'mechanical',
  }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /missing required header label "order id:"[^\n]*\nmissing required header label "scope:"/);
  assert.ok(result.stderr.trimEnd().endsWith(renderOrderHeaderHelp('codex-build')));
  const commaScope = orderFromHeader('codex-build', parseTaskHeader('order id: plan-63\nscope: , ,\nscope new: new.mjs'));
  assert.equal(commaScope.problems.length, 1);
  assert.match(commaScope.problems[0].reason, /`scope:` is required for codex-build/);
  for (const agent of ORDER_AGENTS.filter((agent) => agent !== 'codex-build')) {
    assert.ok(orderFromHeader(agent, parseTaskHeader('scope new: new.mjs')).problems
      .some(({ reason }) => reason.includes('not accepted')));
  }
  const invalidGrant = settle(['--agent', 'codex-review'], 'order id: plan-63\ncontinue: none\n\n## Task\nInspect.');
  assert.equal(invalidGrant.status, 2);
  assert.ok(invalidGrant.stderr.trimEnd().endsWith(renderOrderHeaderHelp('codex-review')));
});

test('scout questions remain required and advisor advise without a grant remains refused', () => {
  const scout = settle(['--agent', 'codex-scout'], orderTaskText({ order: { 'order id': 'plan-63' } }));
  assert.equal(scout.status, 2);
  assert.match(scout.stderr, /a sub-question is required/);
  const advisor = settle(['--agent', 'codex-advisor'], orderTaskText({
    order: { 'order id': 'plan-63', phase: 'advise' },
  }), true);
  assert.equal(advisor.status, 2, advisor.stderr);
  assert.match(advisor.stderr, /requires a `continue:` grant naming the scope run/);
});
