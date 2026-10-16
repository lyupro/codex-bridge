/** Plan_80 A4: stop cause, receipt activity and result availability stay independent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { makeTempTree } from '../temp-tree.mjs';
import { AGENTS } from '../../src/home/lib/write-meta.mjs';
import { runCodex } from '../../src/home/lib/runner/codex-cmd.mjs';
import { buildStopRecord, createStopObservation } from '../../src/home/lib/runner/stop-record.mjs';

const receipts = { lines: 0, last_received_at: null, incomplete: false, truncated: false, write_error: null };
const run = {
  stop: { trigger: 'exit', stopped_at: '2026-10-15T08:00:00.000Z', exit_code: 0,
    signal: null, process_error: null, stdio_drained: true, elapsed_ms: 10,
    tree_stop: { requested: false, method: null, status: null, error: null,
      child_exit_observed: true, state: 'exited' } },
  receipts,
};

function resultTree() {
  const dir = makeTempTree('stop-record-');
  return { dir, file: path.join(dir, AGENTS['codex-review'].result) };
}

test('missing result is observed without adding a file write', () => {
  const { dir } = resultTree();
  const record = buildStopRecord(run, dir, 'codex-review');
  const { sampled_at: sampledAt, ...session } = record.session;
  assert.match(sampledAt, /Z$/);
  assert.deepEqual({ ...record, session }, {
    version: 2, ...run.stop, receipts, result_file: { state: 'missing' },
    // No events.jsonl, so no thread id: the session log was not looked for.
    session: { state: 'not-observed', reason: null, file: null, last_record_at: null,
      last_record_kind: null, records: 0, unknown_kinds: [],
      longest_gap_ms: null, longest_quiet_gap_ms: null,
      at_reference: { as_of: run.stop.stopped_at, last_record_at: null, last_record_kind: null,
        records: 0, commands: { state: 'unknown', reason: 'session not-observed', pending: [] } } },
  });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('read failure records unreadable separately from missing, with its error', () => {
  const { dir, file } = resultTree();
  fs.mkdirSync(file);
  const record = buildStopRecord(run, dir, 'codex-review');
  assert.equal(record.result_file.state, 'unreadable');
  assert.match(record.result_file.error, /EISDIR|EPERM|EACCES/);
});

test('a present non-JSON result is malformed', () => {
  const { dir, file } = resultTree();
  fs.writeFileSync(file, '{broken');
  const observed = buildStopRecord(run, dir, 'codex-review').result_file;
  assert.deepEqual(observed, { state: 'malformed' });
});

test('parsed but unfilled results include null and primitives', () => {
  const { dir, file } = resultTree();
  for (const result of [{}, null, false, 0, '', [], { verdict: '', summary: '' }]) {
    fs.writeFileSync(file, JSON.stringify(result));
    assert.deepEqual(buildStopRecord(run, dir, 'codex-review').result_file, { state: 'unfilled' });
  }
});

test('filled uses the selected agent registry and observes the result exactly once', (t) => {
  const { dir, file } = resultTree();
  fs.writeFileSync(file, JSON.stringify({ verdict: 'approve', summary: 'ok', findings: [], next_steps: [] }));
  const read = t.mock.method(fs, 'readFileSync');
  const record = buildStopRecord(run, dir, 'codex-review');
  assert.deepEqual(record.result_file, { state: 'filled' });
  // The stop record also reads events.jsonl for the thread id; the result itself is read once.
  assert.equal(read.mock.calls.filter((call) => call.arguments[0] === file).length, 1);
  assert.equal(record.receipts, receipts);
  read.mock.restore();
  fs.writeFileSync(file, '{}');
  assert.deepEqual(record.result_file, { state: 'filled' });
  assert.deepEqual(buildStopRecord(run, dir, 'codex-review').result_file, { state: 'unfilled' });
});

test('unknown agents fail loudly', () => {
  const { dir } = resultTree();
  assert.throws(() => buildStopRecord(run, dir, 'unknown'), /unknown agent/);
});

test('deadline before exit keeps its first timestamp and later exit facts', (t) => {
  const now = Date.parse('2026-10-15T08:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const stop = createStopObservation();
  stop.observe('deadline');
  t.mock.timers.tick(1000);
  stop.exit(null, 'SIGKILL');
  stop.observe('stream-error', new Error('late stream error'));
  assert.deepEqual(stop.snapshot(false, 10), {
    trigger: 'deadline', stopped_at: new Date(now).toISOString(), exit_code: null,
    signal: 'SIGKILL', process_error: null, stdio_drained: false, elapsed_ms: 10,
    tree_stop: { requested: false, method: null, status: null, error: null,
      child_exit_observed: true, state: 'exited' },
  });
});

const taskkill = { method: 'taskkill', status: 0, error: null };
const fallback = { method: 'kill', status: null, error: 'taskkill exited with status 1' };
const signal = { method: 'signal', status: null, error: null };

for (const scenario of [
  { name: 'Windows taskkill 0 and exit', windows: true, attempts: [taskkill], exit: true, state: 'stopped' },
  { name: 'Windows failed taskkill then fallback and exit', windows: true,
    attempts: [{ method: 'taskkill', status: 1, error: null }, fallback], exit: true, state: 'unverified' },
  { name: 'Windows no kill and exit', windows: true, attempts: [], exit: true, state: 'exited' },
  { name: 'Windows kill without exit', windows: true, attempts: [taskkill], exit: false, state: 'unverified' },
  { name: 'Windows nonzero taskkill and exit', windows: true,
    attempts: [{ method: 'taskkill', status: 1, error: null }], exit: true, state: 'unverified' },
  { name: 'Windows null taskkill status and exit', windows: true,
    attempts: [{ method: 'taskkill', status: null, error: 'spawn failed' }], exit: true, state: 'unverified' },
  { name: 'Windows successful taskkill then fallback', windows: true,
    attempts: [taskkill, fallback], exit: true, state: 'unverified' },
  { name: 'Windows fallback then successful taskkill', windows: true,
    attempts: [fallback, taskkill], exit: true, state: 'stopped' },
  { name: 'POSIX kill and exit', windows: false, attempts: [signal], exit: true, state: 'stopped' },
  { name: 'POSIX no kill and exit', windows: false, attempts: [], exit: true, state: 'exited' },
  { name: 'POSIX kill without exit', windows: false, attempts: [signal], exit: false, state: 'unverified' },
  { name: 'POSIX no kill or exit', windows: false, attempts: [], exit: false, state: 'unverified' },
  { name: 'Windows exit before a failed kill', windows: true, exitFirst: true,
    attempts: [{ method: 'taskkill', status: 128, error: null }, fallback], exit: true, state: 'exited' },
]) {
  test(`tree stop evidence: ${scenario.name}`, () => {
    const stop = createStopObservation(scenario.windows);
    if (scenario.exitFirst) stop.exit(0, null);
    for (const attempt of scenario.attempts) stop.kill(attempt);
    if (scenario.exit && !scenario.exitFirst) stop.exit(null, 'SIGKILL');
    const last = scenario.attempts.at(-1);
    assert.deepEqual(stop.snapshot(true, 10).tree_stop, {
      requested: Boolean(last), method: last?.method ?? null, status: last?.status ?? null,
      error: last?.error ?? null, child_exit_observed: scenario.exit, state: scenario.state,
    });
  });
}

function fakeCodex(t, stopChild) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { stopChild(); return true; };
  t.mock.method(childProcess, 'spawn', () => child);
  t.mock.method(childProcess, 'spawnSync', () => { stopChild(); return { status: 0 }; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const close = (code) => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code);
  };
  return { child, close };
}

test('runCodex exit records the exit event time before a delayed stdio settlement', async (t) => {
  const { dir } = resultTree();
  const { child, close } = fakeCodex(t, () => assert.fail('normal exit must not kill'));
  const pending = runCodex([], 'task', path.join(dir, 'events.jsonl'), null, { graceMs: 1000 });
  const beforeExit = Date.now();
  child.emit('exit', 7, null);
  const afterExit = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 30));
  close(7);
  const result = await pending;
  assert.equal(result.exit, 7);
  assert.equal(result.stoppedOnDeadline, false);
  assert.equal(result.stop.trigger, 'exit');
  assert.equal(result.stop.exit_code, 7);
  assert.equal(result.stop.signal, null);
  assert.equal(result.stop.process_error, null);
  assert.equal(result.stop.stdio_drained, result.stdioDrained);
  assert.equal(result.stop.elapsed_ms, result.elapsedMs);
  assert.ok(Date.parse(result.stop.stopped_at) >= beforeExit);
  assert.ok(Date.parse(result.stop.stopped_at) <= afterExit);
  assert.ok(Date.now() - Date.parse(result.stop.stopped_at) >= 20);
  assert.deepEqual(buildStopRecord(result, dir, 'codex-review').receipts, result.receipts);
});

test('runCodex drain grace keeps the original exit timestamp', async (t) => {
  const { dir } = resultTree();
  const { child } = fakeCodex(t, () => assert.fail('grace fallback must not kill'));
  const pending = runCodex([], 'task', path.join(dir, 'events.jsonl'), null, { graceMs: 30 });
  child.emit('exit', null, 'SIGTERM');
  const exitedAt = Date.now();
  const result = await pending;
  assert.equal(result.stop.trigger, 'exit');
  assert.equal(result.stop.exit_code, null);
  assert.equal(result.stop.signal, 'SIGTERM');
  assert.equal(result.stop.stdio_drained, false);
  assert.ok(Date.parse(result.stop.stopped_at) <= exitedAt);
  assert.ok(Date.now() - Date.parse(result.stop.stopped_at) >= 20);
});

test('runCodex deadline before exit records deadline time and eventual signal', async (t) => {
  const { dir } = resultTree();
  let killedAt;
  let exitedAt;
  const { child, close } = fakeCodex(t, () => {
    killedAt = Date.now();
    setTimeout(() => {
      exitedAt = Date.now();
      child.emit('exit', null, 'SIGKILL');
      close(null);
    }, 30);
  });
  const result = await runCodex([], 'task', path.join(dir, 'events.jsonl'), 10 / 60000, { graceMs: 1000 });
  assert.equal(result.stoppedOnDeadline, true);
  assert.equal(result.stop.trigger, 'deadline');
  assert.equal(result.stop.signal, 'SIGKILL');
  assert.equal(result.stop.exit_code, null);
  assert.equal(result.stop.process_error, null);
  assert.ok(Date.parse(result.stop.stopped_at) <= killedAt);
  assert.ok(Date.parse(result.stop.stopped_at) < exitedAt);
  assert.equal(result.stop.elapsed_ms, result.elapsedMs);
});

test('runCodex log stream error stops the child and records the error before exit', async (t) => {
  const { dir } = resultTree();
  const events = path.join(dir, 'events.jsonl');
  const broken = new PassThrough();
  const createWriteStream = fs.createWriteStream;
  t.mock.method(fs, 'createWriteStream', (file, options) =>
    file === events ? broken : createWriteStream(file, options));
  queueMicrotask(() => broken.destroy(new Error('events disk full')));
  let stops = 0;
  const { child, close } = fakeCodex(t, () => {
    stops++;
    queueMicrotask(() => { child.emit('exit', 9, null); close(9); });
  });
  const result = await runCodex([], 'task', events, null, { graceMs: 1000 });
  assert.equal(stops, 1);
  assert.equal(result.exit, 1);
  assert.equal(result.stop.trigger, 'stream-error');
  assert.equal(result.stop.process_error, 'events disk full');
  assert.equal(result.stop.exit_code, 9);
  assert.equal(result.stop.signal, null);
});

test('runCodex spawn error without exit keeps null exit facts', async (t) => {
  const { dir } = resultTree();
  const { child, close } = fakeCodex(t, () => assert.fail('spawn error must not acquire a deadline'));
  const pending = runCodex([], 'task', path.join(dir, 'events.jsonl'), null, { graceMs: 1000 });
  child.emit('error', new Error('spawn refused'));
  close(-2);
  const result = await pending;
  assert.equal(result.exit, 1);
  assert.deepEqual(result.stop, { trigger: 'spawn-error', stopped_at: result.stop.stopped_at,
    exit_code: null, signal: null, process_error: 'spawn refused', stdio_drained: true,
    elapsed_ms: result.elapsedMs, tree_stop: { requested: false, method: null, status: null,
      error: null, child_exit_observed: false, state: 'unverified' } });
  assert.ok(Number.isFinite(Date.parse(result.stop.stopped_at)));
});


test('Plan_80 A4: every first trigger owns its time and error despite later triggers', (t) => {
  const now = Date.parse('2026-10-15T08:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const trigger of ['exit', 'deadline', 'stream-error', 'spawn-error']) {
    const stop = createStopObservation();
    const firstAt = new Date().toISOString();
    const error = trigger.endsWith('-error') ? new Error(`${trigger} first`) : undefined;
    if (trigger === 'exit') stop.exit(4, null);
    else stop.observe(trigger, error);
    t.mock.timers.tick(1000);
    for (const later of ['exit', 'deadline', 'stream-error', 'spawn-error']) {
      stop.observe(later, new Error('later error'));
    }
    const record = stop.snapshot(true, 1000);
    assert.equal(record.trigger, trigger);
    assert.equal(record.stopped_at, firstAt);
    assert.equal(record.process_error, error?.message ?? null);
    assert.equal(record.exit_code, trigger === 'exit' ? 4 : null);
    assert.equal(record.signal, null);
  }
});

test('a settlement with no observed trigger names the trigger fields as null', () => {
  const snapshot = createStopObservation().snapshot(true, 5);
  assert.deepEqual(snapshot, {
    trigger: null,
    stopped_at: null,
    process_error: null,
    exit_code: null,
    signal: null,
    stdio_drained: true,
    elapsed_ms: 5,
    tree_stop: { requested: false, method: null, status: null, error: null,
      child_exit_observed: false, state: 'unverified' },
  });
});

test('a thread without a recorded start time still builds the stop record (no throw in the worker)', () => {
  const { dir } = resultTree();
  fs.writeFileSync(path.join(dir, 'events.jsonl'),
    `${JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-0000-0000-000000000000' })}\n`);
  fs.writeFileSync(path.join(dir, 'status.json'), '{}\n');
  const record = buildStopRecord(run, dir, 'codex-review');
  assert.equal(record.session.state, 'not-observed');
  assert.equal(record.session.reason, 'run start time unknown');
});

test('session reference is the first stop time, excluding tool output written during drain', (t) => {
  const { dir } = resultTree();
  const thread = '00000000-0000-4000-8000-000000000001';
  const stopped = Date.parse(run.stop.stopped_at);
  const at = (offset) => new Date(stopped + offset).toISOString();
  const day = new Date(stopped);
  const folder = path.join(dir, 'sessions', String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  const entries = [
    { timestamp: at(-2000), ordinal: 1, type: 'session_meta', payload: { id: thread } },
    { timestamp: at(-1000), ordinal: 2, type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'running', name: 'exec', input: '<private>' } },
    { timestamp: at(1000), ordinal: 3, type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'running', output: '<private>' } },
  ];
  fs.writeFileSync(path.join(folder, 'rollout-2026-10-15T08-00-00-' + thread + '.jsonl'),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ started_at: at(-2000) }));
  fs.writeFileSync(path.join(dir, 'events.jsonl'),
    JSON.stringify({ type: 'thread.started', thread_id: thread }) + '\n');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  const record = buildStopRecord(run, dir, 'codex-review');
  assert.equal(record.version, 2);
  assert.equal(record.session.last_record_at, at(1000));
  assert.deepEqual(record.session.at_reference, {
    as_of: run.stop.stopped_at, last_record_at: at(-1000),
    last_record_kind: 'response_item/custom_tool_call', records: 2,
    commands: { state: 'in-flight', reason: null,
      pending: [{ call_id: 'running', name: 'exec', called_at: at(-1000) }] },
  });
});
