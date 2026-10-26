/** Plan_80 E13 guard 3: resume chains preserve the pass count and the advise scope base. */
import { test } from 'node:test';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTempTree } from '../temp-tree.mjs';
import { passGate } from '../../src/home/lib/runner/pass-gate.mjs';
import { orderRuleMessage } from '../../src/home/lib/order-rules.mjs';

const S = '2026-10-03_180000_scope';
const A = '2026-10-03_180100_advise';
const R1 = '2026-10-03_180200_resume';
const R2 = '2026-10-03_180300_resume';
const START = '2026-10-03T18:00:00.000Z';
const STOP = '2026-10-03T18:01:00.000Z';
const REASON = 'finish the stopped pass';
const TASK = '## Options\n- keep: Keep the boundary.\n- split: Split the boundary.\n## Paths\n- source.mjs\n';

function fixture(agent, phase) {
  const root = makeTempTree('resume-chain-');
  const repoRoot = path.join(root, 'repo');
  const projectRunsRoot = path.join(root, 'runs');
  const codexHome = path.join(root, 'codex-home');
  for (const dir of [repoRoot, projectRunsRoot, codexHome]) fs.mkdirSync(dir);
  const thread = randomUUID();
  const day = new Date(START);
  const folder = path.join(codexHome, 'sessions', String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `rollout-2026-10-03T18-00-00-${thread}.jsonl`),
    `${JSON.stringify({ timestamp: STOP, ordinal: 1, type: 'session_meta', payload: { id: thread } })}\n`);
  return { repoRoot, projectRunsRoot, codexHome, thread,
    opts: { agent, phase, orderId: 'resume-chain', slug: 'resume-chain', continue: true } };
}

function run(tree, name, outcome, extra = {}) {
  const dir = path.join(tree.projectRunsRoot, name);
  fs.mkdirSync(dir);
  const status = {
    agent: tree.opts.agent, phase: tree.opts.phase, repo: tree.repoRoot,
    slug: tree.opts.slug, order_id: tree.opts.orderId, state: 'finished',
    started_at: START, task_hash: 'frozen-task-hash', ...extra,
  };
  const files = {
    'status.json': JSON.stringify(status),
    'meta.json': JSON.stringify({
      agent: status.agent, phase: status.phase, status: outcome, result_ok: outcome === 'OK', session_id: tree.thread,
      stop: { trigger: 'deadline', tree_stop: { state: 'stopped' },
        session: { state: 'observed', last_record_at: STOP } },
    }),
    'worker.json': JSON.stringify({ profile: { model: 'fixture-model', effort: 'high' } }),
    'events.jsonl': `${JSON.stringify({ type: 'thread.started', thread_id: tree.thread })}\n`,
    'task-original.md': TASK,
    'schema.json': '{"type":"object"}\n',
    ...(status.agent === 'codex-advisor' && status.phase === 'advise'
      ? { 'advisor-task.json': '{"frozen":true}\n' } : {}),
    ...(status.agent === 'codex-scout' ? { 'questions.json': '[{"id":"Q1","text":"Inspect the boundary"}]\n' } : {}),
  };
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  return dir;
}

async function gate(tree, kind, name) {
  // E13 requires real session evidence, isolated from the operator's Codex home.
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tree.codexHome;
  try {
    return await passGate({ ...tree, taskText: TASK,
      header: { grant: { kind, run: name, reason: REASON } } });
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
}

function refuses(violation, name) {
  return (error) => {
    assert.equal(error.exitCode, 2);
    assert.ok(error.message.startsWith(orderRuleMessage('resume-grant-usable', {
      violation, run: name,
    })), error.message);
    const lines = error.message.split(/\r?\n/);
    const row = orderDiagnosticMessage('next-action', { variant: 'grant-decision' });
    assert.deepEqual(lines.filter((line) => line.startsWith('Action: ')), [row]);
    assert.equal(lines.at(-1), row);
    assert.match(lines.at(-2), /The run folder was not created; quota was not spent\.$/);
    return true;
  };
}

async function resume(tree, named, destination, outcome, base) {
  const result = await gate(tree, 'resume', named);
  assert.equal(result.resumedFrom, named);
  assert.equal(result.retryOf, null);
  assert.equal(result.advisorTask, null);
  assert.equal(result.resumeInputs.thread_id, tree.thread);
  assert.deepEqual(result.continuationGrant, base ? { run: base, reason: REASON } : null);
  // Model the launcher's provenance fields so the next call judges the real folder chain.
  const dir = run(tree, destination, outcome, {
    resumed_from: result.resumedFrom,
    ...(result.continuationGrant ? { continued_from: result.continuationGrant.run } : {}),
  });
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.resumed_from, named);
  assert.equal(status.continued_from ?? null, base);
  return result;
}

test('scope OK -> advise FAIL -> resume FAIL -> resume OK keeps two spent passes', async () => {
  const tree = fixture('codex-advisor', 'advise');
  run(tree, S, 'OK', { phase: 'scope' });
  run(tree, A, 'FAIL', { continued_from: S });
  await assert.rejects(gate(tree, 'resume', S), refuses('not-last', S));
  const first = await resume(tree, A, R1, 'FAIL', S);
  assert.deepEqual(first.startedChain, [S, A]);
  await assert.rejects(gate(tree, 'resume', A), refuses('not-last', A));
  const second = await resume(tree, R1, R2, 'OK', S);
  assert.deepEqual(second.startedChain, [S, A, R1]);
  await assert.rejects(gate(tree, 'resume', R1), refuses('not-last', R1));
  await assert.rejects(gate(tree, 'resume', R2), refuses('ended-ok', R2));
  await assert.rejects(gate(tree, 'continue', R2), (error) => {
    assert.equal(error.exitCode, 2);
    const spent = [S, A].map((name) => path.join(tree.projectRunsRoot, name)).join(', ');
    assert.ok(error.message.includes(`already spent its allowed continuation on ${spent}.`), error.message);
    assert.match(error.message, /^`continue:` is refused:/);
    const lines = error.message.split(/\r?\n/);
    const row = orderDiagnosticMessage('next-action', { variant: 'grant-decision' });
    assert.deepEqual(lines.filter((line) => line.startsWith('Action: ')), [row]);
    assert.equal(lines.at(-1), row);
    assert.match(lines.at(-2), /The run folder was not created; quota was not spent\.$/);
    return true;
  });
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, A, R1, R2]);
});

test('scout FAIL -> resume FAIL -> resume OK leaves continue available after one pass', async () => {
  const tree = fixture('codex-scout', 'default');
  run(tree, S, 'FAIL');
  await resume(tree, S, R1, 'FAIL', null);
  await assert.rejects(gate(tree, 'resume', S), refuses('not-last', S));
  await resume(tree, R1, R2, 'OK', null);
  await assert.rejects(gate(tree, 'resume', R1), refuses('not-last', R1));
  await assert.rejects(gate(tree, 'resume', R2), refuses('ended-ok', R2));
  const continued = await gate(tree, 'continue', R2);
  assert.deepEqual(continued.continuationGrant, { kind: 'continue', run: R2, reason: REASON });
  assert.equal(continued.resumedFrom, null);
  assert.equal(continued.resumeInputs, null);
  assert.deepEqual(continued.startedChain, [S, R1, R2]);
  assert.deepEqual(fs.readdirSync(tree.projectRunsRoot), [S, R1, R2]);
});
