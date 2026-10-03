/** Plan_75 D1/D4: the 2026-10-03 TradeForge capacity failure must repeat its own pass. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { validScope } from '../meta/advisor-fixtures.mjs';
import { passGate } from '../../src/home/lib/runner/pass-gate.mjs';
import { parseTaskHeader } from '../../src/home/lib/task-header.mjs';

const S = '2026-10-03_180000_scope';
const A = '2026-10-03_180100_advise';
const R = '2026-10-03_180200_retry';
const TASK = '## Options\n- keep: Keep the boundary.\n- split: Split the boundary.\n## Paths\n- source.mjs\n';
const NO_QUOTA = /The run folder was not created; quota was not spent\.$/;

function fixture() {
  const root = makeTempTree('retry-launch-');
  const repoRoot = path.join(root, 'repo');
  const projectRunsRoot = path.join(root, 'runs');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(projectRunsRoot);
  return {
    repoRoot, projectRunsRoot,
    opts: { agent: 'codex-advisor', phase: 'advise', slug: 'tradeforge', orderId: 'o', continue: true },
  };
}

function run(tree, name, status, verdict, files = {}) {
  const dir = path.join(tree.projectRunsRoot, name);
  fs.mkdirSync(dir);
  const record = {
    agent: 'codex-advisor', phase: 'scope', repo: tree.repoRoot, slug: tree.opts.slug,
    order_id: 'o', state: 'finished', started_at: '2026-10-03T18:00:00.000Z', ...status,
  };
  // Plan_75 D1: finished state and no pid exercise the real liveness judge, without a stub.
  fs.writeFileSync(path.join(dir, 'status.json'), `${JSON.stringify(record)}\n`);
  fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify({
    agent: record.agent, phase: record.phase, status: verdict,
  })}\n`);
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  return dir;
}

function tradeforge() {
  const tree = fixture();
  run(tree, S, {}, 'OK', { 'result.json': JSON.stringify(validScope()) });
  run(tree, A, { phase: 'advise', continued_from: S }, 'FAIL');
  return tree;
}

function taskInput(text) {
  const header = parseTaskHeader(text);
  return { header, taskText: header.body.trim() };
}

const retry = (tree, name = A, opts = {}) => passGate({
  ...tree, opts: { ...tree.opts, ...opts },
  ...taskInput(`retry: ${name} \u2014 model at capacity\n\n${TASK}`),
});

function refusal(message) {
  return (error) => {
    assert.equal(error.exitCode, 2);
    assert.match(error.message, message);
    assert.match(error.message, NO_QUOTA);
    return true;
  };
}

test('TradeForge advise retry keeps the failed pass and carries its original OK scope', async () => {
  const tree = tradeforge();
  const gate = await retry(tree);
  assert.equal(gate.retryOf, A);
  assert.deepEqual(gate.continuationGrant, { run: S, reason: 'model at capacity' });
  assert.equal(gate.advisorTask.scope.run, S);
  assert.deepEqual(gate.advisorTask.scope.predicted_risks, validScope().predicted_risks);
  assert.deepEqual(gate.advisorTask.scope.missing_paths, validScope().missing_paths);
  assert.deepEqual(gate.startedChain, [S, A]);
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, A]);
});

for (const [verdict, exitCode] of [['FAIL', 1], ['OK', 0]]) {
  test(`identical original TradeForge advise attaches to saved ${verdict} with repair only for failure`, async (t) => {
    const tree = fixture();
    run(tree, S, {}, 'OK', { 'result.json': JSON.stringify(validScope()) });
    const dir = run(tree, A, { phase: 'advise', continued_from: S }, verdict, {
      'reply.txt': `${verdict} — original advise\n`,
    });
    const lines = [];
    t.mock.method(console, 'log', (...values) => lines.push(values.join(' ')));

    assert.deepEqual(await passGate({
      ...tree, opts: tree.opts, ...taskInput(`continue: ${S} — scope approved\n\n${TASK}`),
    }), { exitCode });
    assert.equal(lines[0], `ATTACH=${dir} order-id=o started=2026-10-03T18:00:00.000Z`);
    if (verdict === 'FAIL') {
      assert.equal(lines.at(-2), 'FAIL — original advise');
      assert.match(lines.at(-1), new RegExp(`Ready retry line: retry: ${A} —`));
    } else {
      assert.equal(lines.at(-1), 'OK — original advise');
      assert.doesNotMatch(lines.join('\n'), /Ready/);
    }
    assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, A]);
  });
}

test('an older saved TradeForge failure prints no repair for the newer retry', async (t) => {
  const tree = tradeforge();
  fs.writeFileSync(path.join(tree.projectRunsRoot, A, 'reply.txt'), 'FAIL — original advise\n');
  run(tree, R, { phase: 'advise', retry_of: A }, 'FAIL');
  const lines = [];
  t.mock.method(console, 'log', (...values) => lines.push(values.join(' ')));

  assert.deepEqual(await passGate({
    ...tree, opts: tree.opts, ...taskInput(`continue: ${S} — scope approved\n\n${TASK}`),
  }), { exitCode: 1 });
  assert.equal(lines.at(-1), 'FAIL — original advise');
  assert.doesNotMatch(lines.join('\n'), /Ready/);
});

test('identical retry attaches only to its retry child and returns that saved verdict', async (t) => {
  const tree = tradeforge();
  // TradeForge: the original failed advise also has this base, so base matching is insufficient.
  fs.writeFileSync(path.join(tree.projectRunsRoot, A, 'reply.txt'), 'FAIL \u2014 original advise\n');
  const dir = run(tree, R, { phase: 'advise', retry_of: A, continued_from: S }, 'OK', {
    'reply.txt': 'OK \u2014 repeated advise\n',
  });
  const lines = [];
  t.mock.method(console, 'log', (...values) => lines.push(values.join(' ')));
  assert.deepEqual(await retry(tree), { exitCode: 0 });
  assert.equal(lines[0], `ATTACH=${dir} order-id=o started=2026-10-03T18:00:00.000Z`);
  assert.equal(lines.at(-1), 'OK \u2014 repeated advise');
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, A, R]);
});

test('retry refuses changing either the named run agent or its phase', async () => {
  for (const opts of [{ phase: 'scope' }, { agent: 'codex-scout' }]) {
    const tree = tradeforge();
    await assert.rejects(retry(tree, A, opts),
      refusal(/a retry repeats the named run's own agent and phase: codex-advisor\/advise/));
    assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, A]);
  }
});

test('failed first scope retries with --continue and has no continuation base', async () => {
  const tree = fixture();
  run(tree, S, {}, 'FAIL');
  const gate = await retry(tree, S, { phase: 'scope' });
  assert.equal(gate.retryOf, S);
  assert.equal(gate.continuationGrant, null);
  assert.equal(Object.hasOwn(gate.advisorTask, 'scope'), false);
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S]);
});

test('scope continuation still refuses with OW-040 before reading the chain', async () => {
  const tree = fixture();
  // OW-040: even a missing runs root must not hide the scope continuation refusal.
  const missingRoot = path.join(tree.projectRunsRoot, 'missing');
  await assert.rejects(passGate({
    ...tree, projectRunsRoot: missingRoot, opts: { ...tree.opts, phase: 'scope' },
    ...taskInput(`continue: ${S} \u2014 repeat scope\n\n${TASK}`),
  }), refusal(/codex-advisor --phase scope refuses --continue:.*a scope run that failed is repeated with a `retry:` grant instead/));
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), []);
});

test('retry without --continue refuses before attaching an older saved reply', async () => {
  const tree = tradeforge();
  fs.writeFileSync(path.join(tree.projectRunsRoot, A, 'reply.txt'), 'FAIL \u2014 original advise\n');
  await assert.rejects(retry(tree, A, { continue: false }), refusal(/--continue is required for a `retry:` grant/));
});

test('matching absent phases can retry a failed single-phase agent run', async () => {
  const tree = fixture();
  run(tree, S, { agent: 'codex-scout', phase: undefined }, 'FAIL');
  const gate = await retry(tree, S, { agent: 'codex-scout', phase: undefined });
  assert.equal(gate.retryOf, S);
  assert.equal(gate.continuationGrant, null);
  assert.equal(gate.advisorTask, null);
});

test('a pre-phase run folder retries under the resolved default phase', async () => {
  // resolveRunPhase answers 'default' for single-phase agents, while folders written before
  // phases existed carry none; the two must compare equal or every old build run is unretryable.
  const tree = fixture();
  run(tree, S, { agent: 'codex-build', phase: undefined }, 'FAIL');
  const gate = await retry(tree, S, { agent: 'codex-build', phase: 'default' });
  assert.equal(gate.retryOf, S);
});

test('ordinary first passes have no retry provenance', async () => {
  const tree = fixture();
  const gate = await passGate({ ...tree, opts: { ...tree.opts, phase: 'scope', continue: false }, ...taskInput(TASK) });
  assert.equal(gate.retryOf, null);
  assert.equal(gate.continuationGrant, null);
});
