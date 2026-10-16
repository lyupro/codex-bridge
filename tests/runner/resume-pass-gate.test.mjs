/** Plan_80 E13 O5: a resume repeats the frozen pass without spending another continuation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { validScope } from '../meta/advisor-fixtures.mjs';
import { passGate } from '../../src/home/lib/runner/pass-gate.mjs';
import { orderRuleMessage } from '../../src/home/lib/order-rules.mjs';

const S = '2026-10-03_180000_scope';
const A = '2026-10-03_180100_advise';
const R = '2026-10-03_180200_repeat';
const START = '2026-10-03T18:00:00.000Z';
const STOP = '2026-10-03T18:01:00.000Z';
const THREAD = 'resume-pass-gate-thread';
const REASON = 'finish the stopped pass';
const TASK = '## Options\n- keep: Keep the boundary.\n- split: Split the boundary.\n## Paths\n- source.mjs\n';
const NO_QUOTA = /The run folder was not created; quota was not spent\.$/;

function fixture() {
  const root = makeTempTree('resume-pass-gate-');
  const repoRoot = path.join(root, 'repo');
  const projectRunsRoot = path.join(root, 'runs');
  const codexHome = path.join(root, 'codex-home');
  for (const dir of [repoRoot, projectRunsRoot, codexHome]) fs.mkdirSync(dir);
  return {
    repoRoot, projectRunsRoot, codexHome,
    opts: { agent: 'codex-advisor', phase: 'advise', slug: 'tradeforge', orderId: 'o', continue: true },
  };
}

function run(tree, name, status, meta) {
  const dir = path.join(tree.projectRunsRoot, name);
  fs.mkdirSync(dir);
  const record = {
    agent: 'codex-advisor', phase: 'scope', repo: tree.repoRoot, slug: tree.opts.slug,
    order_id: 'o', state: 'finished', started_at: START, ...status,
  };
  fs.writeFileSync(path.join(dir, 'status.json'), `${JSON.stringify(record)}\n`);
  // Plan_80 E13: exercise the real eligibility and liveness judges, not cached eligibility.
  fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify({
    agent: record.agent, phase: record.phase, status: 'FAIL', result_ok: false, session_id: THREAD,
    stop: { trigger: 'deadline', tree_stop: { state: 'stopped' },
      session: { state: 'observed', last_record_at: STOP } },
    ...meta,
  })}\n`);
  return dir;
}

function session(tree, lastRecordAt) {
  // The reader selects the run's local start day; derive it so the fixture works in any timezone.
  const day = new Date(START);
  const folder = path.join(tree.codexHome, 'sessions', String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `rollout-2026-10-03T18-00-00-${THREAD}.jsonl`),
    `${JSON.stringify({ timestamp: lastRecordAt, ordinal: 1, type: 'session_meta', payload: { id: THREAD } })}\n`);
}

function adviseFixture() {
  const tree = fixture();
  const scope = run(tree, S, {}, { status: 'OK' });
  fs.writeFileSync(path.join(scope, 'result.json'), JSON.stringify(validScope()));
  run(tree, A, { phase: 'advise', continued_from: S }, {});
  return tree;
}

async function gate(tree, kind, name, options = {}, taskText = TASK) {
  // Plan_80 E13: real session reads must never inspect the operator's Codex home.
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tree.codexHome;
  try {
    return await passGate({
      ...tree, opts: { ...tree.opts, ...options }, taskText,
      header: { grant: { kind, run: name, reason: REASON } },
    });
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
}

function refusal(message, exitCode = 2) {
  return (error) => {
    assert.equal(error.exitCode, exitCode);
    if (typeof message === 'string') assert.ok(error.message.startsWith(message), error.message);
    else assert.match(error.message, message);
    assert.match(error.message, NO_QUOTA);
    return true;
  };
}

test('resume advise carries its original OK scope and returns only resume provenance', async () => {
  const tree = adviseFixture();
  session(tree, STOP);
  const result = await gate(tree, 'resume', A);
  assert.equal(result.resumedFrom, A);
  assert.equal(result.retryOf, null);
  assert.deepEqual(result.continuationGrant, { run: S, reason: REASON });
  assert.equal(result.advisorTask, null);
  assert.deepEqual(result.startedChain, [S, A]);
  assert.deepEqual(Object.keys(result).sort(), [
    'advisorTask', 'chain', 'continuationGrant', 'resumedFrom', 'retryOf', 'startedChain', 'taskHash',
  ]);
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, A]);
});

test('resume does not regenerate the advisor task from changed task or scope result', async () => {
  const tree = fixture();
  // Plan_80 E13: metadata still proves an OK scope; replay must not parse its result or the new task.
  run(tree, S, {}, { status: 'OK' });
  run(tree, A, { phase: 'advise', continued_from: S }, {});
  session(tree, STOP);
  const result = await gate(tree, 'resume', A, {}, 'not a fresh advisor task');
  assert.equal(result.advisorTask, null);
  assert.deepEqual(result.continuationGrant, { run: S, reason: REASON });
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, A]);
});

test('resume still refuses an unsuccessful carried scope before creating a folder', async () => {
  const tree = fixture();
  run(tree, S, {}, {});
  run(tree, A, { phase: 'advise', continued_from: S }, {});
  session(tree, STOP);
  await assert.rejects(gate(tree, 'resume', A), refusal(/continued run meta.json failed status must be 'OK'/, 1));
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, A]);
});

test('an OK named run refuses with resume-grant-usable before any session read', async () => {
  const tree = fixture();
  run(tree, A, { phase: 'advise' }, { status: 'OK' });
  await assert.rejects(gate(tree, 'resume', A), refusal(orderRuleMessage('resume-grant-usable', {
    violation: 'ended-ok', run: A,
  })));
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [A]);
});

test('a non-last named run refuses with resume-grant-usable and creates no folder', async () => {
  const tree = adviseFixture();
  run(tree, R, { phase: 'advise', resumed_from: A, continued_from: S }, {});
  await assert.rejects(gate(tree, 'resume', A), refusal(orderRuleMessage('resume-grant-usable', {
    violation: 'not-last', run: A,
  })));
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, A, R]);
});

test('advisor scope resume bypasses the scope continuation rule and has no continuation base', async () => {
  const tree = fixture();
  run(tree, S, {}, {});
  session(tree, STOP);
  const result = await gate(tree, 'resume', S, { phase: 'scope' });
  assert.equal(result.resumedFrom, S);
  assert.equal(result.retryOf, null);
  assert.equal(result.continuationGrant, null);
  assert.equal(result.advisorTask, null);
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S]);
});

test('resume refuses changing either the named pass agent or its phase', async () => {
  for (const options of [{ agent: 'codex-scout' }, { phase: 'scope' }]) {
    const tree = adviseFixture();
    await assert.rejects(gate(tree, 'resume', A, options), refusal(orderRuleMessage('resume-pass-identity', {
      agent: 'codex-advisor', phase: 'advise',
    })));
    assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, A]);
  }
});

test('resume refuses a run without stop evidence before reading its thread', async () => {
  const tree = fixture();
  run(tree, A, { phase: 'advise' }, { stop: null });
  await assert.rejects(gate(tree, 'resume', A), refusal(/Resume is refused:.*stop-record-missing/));
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [A]);
});

test('resume refuses an unreadable thread in the temporary Codex home', async () => {
  const tree = adviseFixture();
  await assert.rejects(gate(tree, 'resume', A), refusal(orderRuleMessage('resume-grant-usable', {
    violation: 'thread-unreadable', run: A, state: 'missing', reason: null,
  })));
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, A]);
});

test('resume refuses a thread that advanced after the recorded stop', async () => {
  const tree = adviseFixture();
  const advancedAt = '2026-10-03T18:02:00.000Z';
  session(tree, advancedAt);
  await assert.rejects(gate(tree, 'resume', A), refusal(orderRuleMessage('resume-grant-usable', {
    violation: 'thread-advanced-after-stop', run: A, recordedAt: STOP, currentAt: advancedAt,
  })));
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, A]);
});

test('retry retains its original scope and advisor task and has no resume provenance', async () => {
  const tree = adviseFixture();
  const result = await gate(tree, 'retry', A);
  assert.equal(result.resumedFrom, null);
  assert.equal(result.retryOf, A);
  assert.deepEqual(result.continuationGrant, { run: S, reason: REASON });
  assert.equal(result.advisorTask.scope.run, S);
  assert.deepEqual(result.advisorTask.scope.predicted_risks, validScope().predicted_risks);
  assert.deepEqual(result.advisorTask.scope.missing_paths, validScope().missing_paths);
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, A]);
});
