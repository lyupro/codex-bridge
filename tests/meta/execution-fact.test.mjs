import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { readEvents } from '../../src/home/lib/meta/events.mjs';
import { line } from '../../src/home/lib/meta/paths.mjs';
import {
  EXECUTION_FACT_VERSION, readExecutionFact,
} from '../../src/home/lib/meta/execution-fact.mjs';

const json = (dir, file, value) =>
  fs.writeFileSync(path.join(dir, file), `${JSON.stringify(value)}\n`, 'utf8');

function makeRun(root, name, { count = 0, thread = 'same-thread', from, stream = true, meta } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  json(dir, 'status.json', { resumed_from: from });
  if (stream) {
    const events = [
      ...(thread === null ? [] : [{ type: 'thread.started', thread_id: thread }]),
      ...Array.from({ length: count }, () => ({
        type: 'item.completed', item: { type: 'command_execution' },
      })),
    ];
    fs.writeFileSync(path.join(dir, 'events.jsonl'),
      events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
  }
  if (meta !== undefined) json(dir, 'meta.json', meta);
  return dir;
}

const factOf = (dir) => readExecutionFact(dir, readEvents(dir));
const rootOf = () => makeTempTree('execution-fact-');
const assertGap = (fact, name, why) => {
  assert.equal(fact.chain, null);
  assert.equal(fact.gap, `resume chain: ${line(name, 60)} — ${why}`);
};

test('ordinary run counts three completed commands', () => {
  const dir = makeRun(rootOf(), 'current', { count: 3 });
  assert.equal(EXECUTION_FACT_VERSION, 1);
  assert.deepEqual(factOf(dir), { version: 1, run: 3, chain: 3, chain_runs: [], gap: null });
});

test('ordinary archived run keeps null counts', () => {
  const dir = makeRun(rootOf(), 'archived', { stream: false });
  assert.deepEqual(factOf(dir), { version: 1, run: null, chain: null, chain_runs: [], gap: null });
});

test('the supplied current-run events are used without rereading its stream', () => {
  const dir = makeRun(rootOf(), 'current', { count: 3 });
  const events = readEvents(dir);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '', 'utf8');
  assert.equal(readExecutionFact(dir, events).run, 3);
  assert.throws(() => readExecutionFact(dir), TypeError);
});

test('a zero-command resume counts eight predecessor commands', () => {
  const root = rootOf();
  makeRun(root, 'previous', { count: 8 });
  const dir = makeRun(root, 'current', { from: 'previous' });
  assert.deepEqual(factOf(dir), {
    version: 1, run: 0, chain: 8, chain_runs: ['previous'], gap: null,
  });
});

test('resume of a resume sums own counts nearest first, ignoring stored totals', () => {
  const root = rootOf();
  makeRun(root, 'oldest', { count: 5 });
  makeRun(root, 'previous', {
    count: 2, from: 'oldest', meta: { commands_executed: { run: 90, chain: 100 } },
  });
  const dir = makeRun(root, 'current', { count: 1, from: 'previous' });
  assert.deepEqual(factOf(dir), {
    version: 1, run: 1, chain: 8, chain_runs: ['previous', 'oldest'], gap: null,
  });
});

test('different predecessor thread prevents a chain total', () => {
  const root = rootOf();
  makeRun(root, 'previous', { count: 8, thread: 'different-thread' });
  assertGap(factOf(makeRun(root, 'current', { from: 'previous' })), 'previous', 'different thread');
});

test('pruned predecessor uses retained session id and its own recorded count', () => {
  const root = rootOf();
  const pred = makeRun(root, 'previous', {
    count: 4,
    meta: { session_id: 'same-thread', commands_executed: { run: 4, chain: 99 } },
  });
  fs.unlinkSync(path.join(pred, 'events.jsonl'));
  const fact = factOf(makeRun(root, 'current', { from: 'previous' }));
  assert.deepEqual(fact, { version: 1, run: 0, chain: 4, chain_runs: ['previous'], gap: null });
});

test('a recorded chain alone cannot replace pruned command evidence', () => {
  const root = rootOf();
  makeRun(root, 'previous', {
    stream: false, meta: { session_id: 'same-thread', commands_executed: { chain: 4 } },
  });
  assertGap(factOf(makeRun(root, 'current', { from: 'previous' })), 'previous',
    'no command evidence (stream pruned, no recorded count)');
});

test('invalid retained own counts do not silently become zero', () => {
  for (const run of [-1, 1.5, '4', null]) {
    const root = rootOf();
    makeRun(root, 'previous', {
      stream: false, meta: { session_id: 'same-thread', commands_executed: { run } },
    });
    assertGap(factOf(makeRun(root, 'current', { from: 'previous' })), 'previous',
      'no command evidence (stream pruned, no recorded count)');
  }
});

test('recorded thread disagreement is reported before thread mismatch or missing count', () => {
  const root = rootOf();
  makeRun(root, 'previous', { thread: 'A', meta: { session_id: 'B' } });
  assertGap(factOf(makeRun(root, 'current', { from: 'previous' })), 'previous',
    'recorded thread disagrees with its stream');
});

test('two runs naming each other fail on the already visited current run', () => {
  const root = rootOf();
  makeRun(root, 'previous', { from: 'current', count: 2 });
  const fact = factOf(makeRun(root, 'current', { from: 'previous' }));
  assertGap(fact, 'current', 'cycle in resumed_from');
  assert.deepEqual(fact.chain_runs, ['previous']);
});

test('a self-cycle is rejected before reading predecessor thread evidence', () => {
  const dir = makeRun(rootOf(), 'current', { from: 'current' });
  assertGap(factOf(dir), 'current', 'cycle in resumed_from');
});

test('non-bare resumed_from values are ordinary runs', () => {
  for (const from of ['../x', '..\\x', '.', '..', '', '   ', 42, null]) {
    const dir = makeRun(rootOf(), 'current', { from, count: 3 });
    assert.deepEqual(factOf(dir), { version: 1, run: 3, chain: 3, chain_runs: [], gap: null });
  }
});

test('a predecessor with a non-bare origin terminates the valid chain', () => {
  const root = rootOf();
  makeRun(root, 'previous', { from: '../x', count: 2 });
  const fact = factOf(makeRun(root, 'current', { from: 'previous' }));
  assert.equal(fact.chain, 2);
  assert.equal(fact.gap, null);
});

test('a missing predecessor folder fails before thread or count checks', () => {
  const dir = makeRun(rootOf(), 'current', { from: 'missing' });
  assertGap(factOf(dir), 'missing', 'run folder not found');
});

test('a regular file is not a predecessor directory', () => {
  const root = rootOf();
  fs.writeFileSync(path.join(root, 'previous'), '', 'utf8');
  assertGap(factOf(makeRun(root, 'current', { from: 'previous' })), 'previous', 'run folder not found');
});

test('canonical containment rejects a junction outside the project runs folder first', () => {
  const root = rootOf();
  const runs = path.join(root, 'runs');
  fs.mkdirSync(runs);
  const outside = makeRun(root, 'outside', { thread: 'different-thread' });
  fs.symlinkSync(outside, path.join(runs, 'previous'), process.platform === 'win32' ? 'junction' : 'dir');
  const dir = makeRun(runs, 'current', { from: 'previous' });
  assertGap(factOf(dir), 'previous', "outside this project's runs folder");
});

test('canonical identity detects a cycle through a directory alias', () => {
  const root = rootOf();
  const dir = makeRun(root, 'current', { from: 'alias' });
  fs.symlinkSync(dir, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assertGap(factOf(dir), 'alias', 'cycle in resumed_from');
});

test('unknown current thread fails before walking even a missing predecessor', () => {
  const dir = makeRun(rootOf(), 'current', { from: 'missing', thread: null });
  assertGap(factOf(dir), 'current', 'thread id unknown');
  const data = readEvents(dir);
  for (const session_id of ['', '   ', 42]) {
    assertGap(readExecutionFact(dir, { ...data, session_id }), 'current', 'thread id unknown');
  }
});

test('a stream with no thread cannot borrow a recorded thread', () => {
  const root = rootOf();
  makeRun(root, 'previous', { thread: null, meta: { session_id: 'same-thread' } });
  assertGap(factOf(makeRun(root, 'current', { from: 'previous' })), 'previous', 'thread id unknown');
});

test('a pruned predecessor needs a known matching recorded thread', () => {
  for (const session_id of [null, '', '   ', 'different-thread']) {
    const root = rootOf();
    makeRun(root, 'previous', { stream: false, meta: { session_id, commands_executed: { run: 4 } } });
    assertGap(factOf(makeRun(root, 'current', { from: 'previous' })), 'previous',
      session_id === 'different-thread' ? 'different thread' : 'thread id unknown');
  }
});

test('zero-command predecessors and resumes stay zero without a gap', () => {
  const root = rootOf();
  makeRun(root, 'previous');
  assert.deepEqual(factOf(makeRun(root, 'current', { from: 'previous' })), {
    version: 1, run: 0, chain: 0, chain_runs: ['previous'], gap: null,
  });
});

test('a pruned recorded zero is valid command evidence', () => {
  const root = rootOf();
  makeRun(root, 'previous', {
    stream: false, meta: { session_id: 'same-thread', commands_executed: { run: 0 } },
  });
  const fact = factOf(makeRun(root, 'current', { from: 'previous' }));
  assert.equal(fact.chain, 0);
  assert.equal(fact.gap, null);
});

test('a gap beyond a valid predecessor never exposes a partial total', () => {
  const root = rootOf();
  makeRun(root, 'previous', { count: 8, from: 'missing' });
  const fact = factOf(makeRun(root, 'current', { count: 1, from: 'previous' }));
  assert.equal(fact.run, 1);
  assert.deepEqual(fact.chain_runs, ['previous']);
  assertGap(fact, 'missing', 'run folder not found');
});

test('gap names are bounded to sixty characters', () => {
  const name = 'x'.repeat(100);
  const dir = makeRun(rootOf(), 'current', { from: name });
  assertGap(factOf(dir), name, 'run folder not found');
  assert.ok(line(name, 60).length <= 60);
});

test('module never reads a predecessor stored chain total', () => {
  const source = fs.readFileSync(new URL('../../src/home/lib/meta/execution-fact.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:\?\.|\.)\s*chain\b|\[\s*['"]chain['"]\s*\]/);
});
