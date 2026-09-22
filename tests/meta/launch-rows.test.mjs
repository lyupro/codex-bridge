/** Guards launch facts in every reply path after the 2026-09-16 dead sandbox incident. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, collect, writeFailure } from '../../src/home/lib/write-meta.mjs';
import { launchRows, withLaunchRows } from '../../src/home/lib/meta/launch-rows.mjs';
import { buildResult, COMPLETED_COMMAND, makeRun } from './test-fixtures.mjs';
import { advisorRunFacts, validScope } from './advisor-fixtures.mjs';

const retention = { bytes_freed: 41.2 * 1024 * 1024, runs: 12, days: 30 };
const retentionRow = 'Retention: freed 41.2 MB from 12 runs older than 30 days';
const probe = { outcome: 'inconclusive', reason: 'probe flags were rejected', attempts: 2 };
const probeRow = 'Sandbox probe: inconclusive — probe flags were rejected The run started without a sandbox check.';
const profile = { model: 'fixture-model', effort: 'high', effort_source: 'config' };
const modelRow = 'Model: fixture-model at high effort (config)';
const started = [{ type: 'thread.started', thread_id: 'launch-rows' }];
const agents = [
  ['codex-build', buildResult([])],
  ['codex-scout', {
    answer: 'The launcher stores startup facts in the status artifact before the worker begins. '
      + 'Both reply assemblers must carry those facts to the orchestrator, including when the '
      + 'worker fails or reaches a quota limit. An inconclusive probe means sandbox behavior was not verified.',
    findings: [], unknowns: [], report_markdown: '# report',
  }],
  ['codex-review', { verdict: 'approve', findings: [] }],
  ['codex-advisor', validScope()],
];

for (const [agent, result] of agents) {
  for (const status of ['OK', 'FAIL', 'LIMIT']) {
    test(`${agent} ${status} replies keep Retention, Sandbox probe, Model and Log consecutive`, () => {
      const dir = makeRun({
        args: ['exec', '--json'],
        events: status === 'LIMIT' ? [{ type: 'error', message: 'rate limit exceeded for this account' }]
          : ['codex-scout', 'codex-advisor'].includes(agent) && status === 'OK' ? [...started, COMPLETED_COMMAND] : started,
        result: status === 'OK' ? result : undefined,
        file: AGENTS[agent].result,
        profile,
        status: { state: 'running', retention, sandbox_probe: probe },
      });
      if (agent === 'codex-advisor') advisorRunFacts(dir);

      const { meta, reply } = collect(dir, agent, status === 'OK' ? 0 : 1);
      const rows = reply.split('\n');
      const logAt = rows.findIndex((row) => row.includes('Log: '));

      assert.equal(meta.status, status, meta.reason);
      assert.ok(logAt >= 3);
      assert.deepEqual(rows.slice(logAt - 3, logAt), [retentionRow, probeRow, modelRow]);
      assert.ok(rows[logAt].includes(`Log: codex-bridge read ${dir}`));
      assert.equal(rows.filter((row) => row.startsWith('Retention: ')).length, 1);
      assert.equal(rows.filter((row) => row.startsWith('Sandbox probe: ')).length, 1);
    });
  }
}

for (const preStart of [false, true]) {
  test(`writeFailure preserves launch facts directly before Run (preStart=${preStart})`, () => {
    const dir = makeRun({ status: { state: 'running', retention, sandbox_probe: probe } });

    const { meta, reply } = writeFailure(dir, 'codex-build', 'runner stopped', ['Detail: kept'], preStart);
    const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));

    assert.equal(meta.status, 'FAIL');
    assert.deepEqual(reply.split('\n'), [
      'FAIL — runner stopped', 'Detail: kept', retentionRow, probeRow, `Run: ${dir}`,
    ]);
    assert.equal(status.state, preStart ? 'aborted_pre_start' : 'failed');
    assert.deepEqual(status.retention, retention);
    assert.deepEqual(status.sandbox_probe, probe);
    assert.equal(Object.hasOwn(meta, 'retention'), false);
    assert.equal(Object.hasOwn(meta, 'sandbox_probe'), false);
  });
}

test('writeFailure closes status.json before reading launch facts for its reply', (t) => {
  const dir = makeRun({ status: { state: 'running', retention, sandbox_probe: probe } });
  const statusPath = path.join(dir, 'status.json');
  const readFileSync = fs.readFileSync;
  const writeFileSync = fs.writeFileSync;
  const operations = [];
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (file === statusPath) operations.push('read');
    return readFileSync.call(this, file, ...args);
  });
  t.mock.method(fs, 'writeFileSync', function (file, ...args) {
    if (file === statusPath) operations.push('write');
    return writeFileSync.call(this, file, ...args);
  });

  writeFailure(dir, 'codex-build', 'runner stopped');

  const writeAt = operations.indexOf('write');
  assert.ok(writeAt >= 0);
  assert.ok(operations.slice(writeAt + 1).includes('read'));
});

for (const outcome of ['alive', 'skipped', undefined]) {
  test(`collect and writeFailure omit the sandbox row for outcome ${outcome}`, () => {
    const dir = makeRun({
      args: ['exec', '--json'],
      events: started,
      result: buildResult([]),
      status: { retention, ...(outcome === undefined ? {} : { sandbox_probe: { ...probe, outcome } }) },
    });

    const collected = collect(dir, 'codex-build', 0);
    const failure = writeFailure(dir, 'codex-build', 'runner stopped');

    assert.equal(collected.meta.status, 'OK');
    for (const { reply } of [collected, failure]) {
      assert.doesNotMatch(reply, /^Sandbox probe:/m);
      assert.ok(reply.includes(retentionRow));
    }
    assert.deepEqual(launchRows(dir), [retentionRow]);
  });
}

test('launchRows tolerates absent, broken and empty status.json', () => {
  for (const contents of [undefined, '{broken json', '', 'null', '{}']) {
    const dir = makeRun();
    if (contents !== undefined) fs.writeFileSync(path.join(dir, 'status.json'), contents);
    const rows = ['OK — done', 'Log: existing'];

    assert.deepEqual(launchRows(dir), []);
    assert.strictEqual(withLaunchRows(rows, dir), rows);
  }
});

test('only the exact inconclusive outcome emits a sandbox row', () => {
  for (const sandbox_probe of [null, {}, { reason: 'no outcome' }, { outcome: 'unknown' }, { outcome: 'INCONCLUSIVE' }]) {
    assert.deepEqual(launchRows(makeRun({ status: { sandbox_probe } })), []);
  }
});

test('an inconclusive probe without a reason says no reason recorded', () => {
  for (const reason of [undefined, null, '', ' \r\n\t ']) {
    const dir = makeRun({ status: { sandbox_probe: { outcome: 'inconclusive', reason } } });

    assert.deepEqual(launchRows(dir), [
      'Sandbox probe: inconclusive — no reason recorded The run started without a sandbox check.',
    ]);
  }
});

test('a long multiline reason is bounded to 160 characters without splitting the reply', () => {
  const reason = `\r\n\t${'x'.repeat(200)}\nextra diagnostic text`;
  const expected = `Sandbox probe: inconclusive — ${'x'.repeat(157)}... The run started without a sandbox check.`;
  const dir = makeRun({
    args: ['exec', '--json'],
    events: started,
    result: buildResult([]),
    status: { sandbox_probe: { ...probe, reason } },
  });

  assert.deepEqual(launchRows(dir), [expected]);
  for (const { reply } of [collect(dir, 'codex-build', 0), writeFailure(dir, 'codex-build', 'runner stopped')]) {
    const rows = reply.split('\n');
    assert.deepEqual(rows.filter((row) => row.startsWith('Sandbox probe: ')), [expected]);
    assert.doesNotMatch(reply, /extra diagnostic text|\r|\t/);
  }
});

test('reason whitespace is normalized and truncation preserves whole words', () => {
  const dir = makeRun({
    status: { sandbox_probe: { ...probe, reason: `  probe\n\t${'rejected '.repeat(30)}` } },
  });

  assert.deepEqual(launchRows(dir), [
    `Sandbox probe: inconclusive — probe ${'rejected '.repeat(15)}rejected... The run started without a sandbox check.`,
  ]);
});

test('Retention retains its byte units, numeric coercion and exact wording', () => {
  for (const [bytes, formatted] of [[1, '1.0 B'], [1024, '1.0 KB'], [1024 ** 2, '1.0 MB'], [1024 ** 3, '1.0 GB']]) {
    const dir = makeRun({ status: { retention: { bytes_freed: String(bytes), runs: '2', days: '30' } } });

    assert.deepEqual(launchRows(dir), [`Retention: freed ${formatted} from 2 runs older than 30 days`]);
  }
});

test('Retention still requires positive finite bytes, runs and days', () => {
  for (const field of ['bytes_freed', 'runs', 'days']) {
    for (const value of [undefined, null, '', 0, -1, 'not a number', 'Infinity']) {
      const dir = makeRun({ status: { retention: { ...retention, [field]: value }, sandbox_probe: probe } });

      assert.deepEqual(launchRows(dir), [probeRow], `${field}=${value}`);
    }
  }
});

test('withLaunchRows prefers the first Log substring over an earlier Run row without mutating input', () => {
  const dir = makeRun({ status: { retention, sandbox_probe: probe } });
  const rows = Object.freeze(['OK — done', 'Run: earlier', 'Report: report.md · Log: first', 'Log: second']);

  assert.deepEqual(withLaunchRows(rows, dir), [
    'OK — done', 'Run: earlier', retentionRow, probeRow, 'Report: report.md · Log: first', 'Log: second',
  ]);
});

test('withLaunchRows falls back to the first Run prefix', () => {
  const dir = makeRun({ status: { retention, sandbox_probe: probe } });
  const rows = ['FAIL — stopped', 'Detail: Run: not a link', 'Run: first', 'Run: second'];

  assert.deepEqual(withLaunchRows(rows, dir), [
    'FAIL — stopped', 'Detail: Run: not a link', retentionRow, probeRow, 'Run: first', 'Run: second',
  ]);
});

test('withLaunchRows appends facts when neither link is present, including an empty reply', () => {
  const dir = makeRun({ status: { retention, sandbox_probe: probe } });

  assert.deepEqual(withLaunchRows(['OK — done'], dir), ['OK — done', retentionRow, probeRow]);
  assert.deepEqual(withLaunchRows([], dir), [retentionRow, probeRow]);
});
