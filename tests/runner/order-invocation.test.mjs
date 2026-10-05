/** Guards Plan_63 D5's shared order-to-invocation boundary before the channel switch. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { ALL_ORDER_LABELS, orderInputName } from '../../src/home/lib/order-schema.mjs';
import { orderInvocation, orderTaskText } from './order-invocation.mjs';

function fixture(t) {
  const dir = makeTempTree('order-invocation-');
  t.after(() => removeTempTree(dir));
  return dir;
}

test('one task file has adjacent advice and grant headers before task, questions, and verify', (t) => {
  const dir = fixture(t);
  const options = {
    agent: 'codex-build', advice: 'mechanical',
    grant: { kind: 'continue', run: 'prior-run', reason: 'finish verification' },
    task: 'Build it.', questions: ['Why?', 'How?'], verify: 'npm test',
  };
  const { taskFile } = orderInvocation({ ...options, dir });
  const expected = 'advice: mechanical\ncontinue: prior-run — finish verification\n\n'
    + '## Task\nBuild it.\n\n## Questions\n- Why?\n- How?\n\n## Verify\nnpm test\n';
  assert.equal(fs.readFileSync(taskFile, 'utf8'), expected);
  assert.equal(orderTaskText(options), expected);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(taskFile)]);
});

test('argv contains the agent, absolute task file, and each given label in schema order', (t) => {
  const dir = fixture(t);
  const order = {
    slug: 'probe', 'scope new': 'src/new.mjs', scope: 'src/existing.mjs', repository: dir,
    phase: 'default', 'order id': 'order-63', effort: 'medium', changeset: 'uncommitted',
  };
  const { argv, taskFile } = orderInvocation({ agent: 'codex-build', order, dir });
  assert.equal(path.isAbsolute(taskFile), true);
  assert.equal(path.dirname(taskFile), dir);
  assert.deepEqual(argv, ['--agent', 'codex-build', '--task-file', taskFile,
    ...ALL_ORDER_LABELS.filter((label) => Object.hasOwn(order, label))
      .flatMap((label) => [orderInputName(label), order[label]])]);
});

test('omitted labels and optional sections add nothing and task has its documented default', (t) => {
  const dir = fixture(t);
  const { argv, taskFile } = orderInvocation({ agent: 'codex-review', dir });
  assert.deepEqual(argv, ['--agent', 'codex-review', '--task-file', taskFile]);
  assert.equal(fs.readFileSync(taskFile, 'utf8'), '## Task\nInspect the repository.\n');
  const partial = orderInvocation({ agent: 'codex-review', dir, order: { 'order id': 'partial' }, task: '' });
  assert.deepEqual(partial.argv, ['--agent', 'codex-review', '--task-file', partial.taskFile,
    orderInputName('order id'), 'partial']);
  assert.equal(fs.readFileSync(partial.taskFile, 'utf8'), '## Task\n\n');
});

test('continue and retry grants add their header and the continuation flag', (t) => {
  const dir = fixture(t);
  for (const kind of ['continue', 'retry']) {
    const { argv, taskFile } = orderInvocation({
      agent: 'codex-build', dir, grant: { kind, run: 'prior-run', reason: 'finish it' },
    });
    assert.deepEqual(argv, ['--agent', 'codex-build', '--task-file', taskFile, orderInputName('continue')]);
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
