/** Guards Plan_57 D27: run-folder identity, fail-open writers, and artifact-based state repair. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runLiveness, workerMayBeAlive } from '../../src/home/lib/meta/run-liveness.mjs';
import { activeRunDetails, markAbandoned } from '../../src/home/lib/meta/run-state.mjs';
import { HEARTBEAT_FILE, HEARTBEAT_STALE_MS } from '../../src/home/lib/heartbeat.mjs';
import {
  IDENTITY_ALIVE,
  IDENTITY_DEAD,
  IDENTITY_FOREIGN,
  IDENTITY_UNVERIFIED,
} from '../../src/home/lib/process-identity.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const now = Date.now();
const recordedStart = now - 10_000;
const running = Object.freeze({ state: 'running', pid: 42, process_started_at: recordedStart });
const allNull = {
  recordedState: null, identity: null, processMayBeAlive: null, heartbeatAgeMs: null, state: null,
};

function fixture(t) {
  const runDir = makeTempTree('codex-run-liveness-');
  t.after(() => removeTempTree(runDir));
  return runDir;
}

function writeJson(runDir, name, value) {
  fs.writeFileSync(path.join(runDir, name), JSON.stringify(value));
}

function heartbeat(runDir, age) {
  const file = path.join(runDir, HEARTBEAT_FILE);
  fs.writeFileSync(file, 'progress\n');
  const at = new Date(now - age);
  fs.utimesSync(file, at, at);
  return now - fs.statSync(file).mtimeMs;
}

function noProcess() {
  throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
}

function permissionDenied() {
  throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
}

test('a liveness question requires a non-empty run folder', () => {
  assert.throws(() => runLiveness(), TypeError);
  assert.throws(() => runLiveness(null), TypeError);
  assert.throws(() => runLiveness({}), TypeError);
  for (const runDir of [undefined, null, '', '   ', 42, false, {}, []]) {
    assert.throws(() => runLiveness({ runDir }), TypeError);
  }
});

test('a missing status file returns an all-null result', (t) => {
  const runDir = fixture(t);
  assert.deepEqual(runLiveness({ runDir }), allNull);
});

test('undefined status reads the recorded status file', (t) => {
  const runDir = fixture(t);
  writeJson(runDir, 'status.json', running);
  assert.deepEqual(runLiveness({ runDir, status: undefined, now, kill: noProcess }), {
    recordedState: 'running', identity: IDENTITY_DEAD, processMayBeAlive: false,
    heartbeatAgeMs: null, state: 'abandoned',
  });
});

test('explicit status is used unchanged without reading status.json', (t) => {
  const runDir = fixture(t);
  writeJson(runDir, 'status.json', { state: 'finished' });
  const read = t.mock.method(fs, 'readFileSync');
  let receivedOptions;
  const result = runLiveness({
    runDir, status: running, now, kill: () => {},
    probe: (pid, options) => {
      receivedOptions = options;
      return recordedStart;
    },
  });
  assert.equal(result.state, 'running');
  assert.strictEqual(receivedOptions.status, running);
  assert.equal(read.mock.calls.some(({ arguments: args }) => args[0] === path.join(runDir, 'status.json')), false);
});

test('missing or non-string state and non-object status remain unknown without probing', (t) => {
  const runDir = fixture(t);
  writeJson(runDir, 'status.json', running);
  const kill = t.mock.fn(() => assert.fail('unknown records must not probe identity'));
  for (const status of [null, 0, 1, false, true, 'running', [], {}, { state: null }, { state: 42 }]) {
    assert.deepEqual(runLiveness({ runDir, status, kill }), allNull);
  }
  assert.equal(kill.mock.callCount(), 0);
});

test('invalid or non-object status files remain unknown', (t) => {
  const runDir = fixture(t);
  for (const contents of ['{', 'null', 'false', '42', '"running"', '[]']) {
    fs.writeFileSync(path.join(runDir, 'status.json'), contents);
    assert.deepEqual(runLiveness({ runDir }), allNull);
  }
});

for (const state of ['finished', 'abandoned', 'aborted_pre_start', 'failed', '']) {
  test(`recorded ${JSON.stringify(state)} is preserved without an identity probe`, (t) => {
    const runDir = fixture(t);
    const kill = t.mock.fn(() => assert.fail('closed records must not probe identity'));
    assert.deepEqual(runLiveness({ runDir, status: { ...running, state }, kill }), {
      recordedState: state, identity: null, processMayBeAlive: null, heartbeatAgeMs: null, state,
    });
    assert.equal(kill.mock.callCount(), 0);
  });
}

// D28 separates waiting for a closing worker from judging the recorded run state.
for (const [state, identity, kill, startedAt, expected] of [
  ['finished', IDENTITY_ALIVE, () => {}, recordedStart, true],
  ['finished', IDENTITY_UNVERIFIED, permissionDenied, null, true],
  ['finished', IDENTITY_DEAD, noProcess, recordedStart, false],
  ['running', IDENTITY_FOREIGN, permissionDenied, recordedStart + 60_000, false],
]) {
  test(`a recorded ${state} worker with ${identity} identity may be alive: ${expected}`, (t) => {
    const runDir = fixture(t);
    assert.equal(workerMayBeAlive({
      runDir, status: { ...running, state }, now, kill, probe: () => startedAt,
    }), expected);
  });
}

test('a worker liveness question requires a non-empty run folder', () => {
  assert.throws(() => workerMayBeAlive(), TypeError);
  assert.throws(() => workerMayBeAlive(null), TypeError);
  assert.throws(() => workerMayBeAlive({}), TypeError);
  for (const runDir of [undefined, null, '', '   ', 42, false, {}, []]) {
    assert.throws(() => workerMayBeAlive({ runDir }), TypeError);
  }
});

test('a worker with no status file cannot be alive', (t) => {
  const runDir = fixture(t);
  const kill = t.mock.fn(() => assert.fail('missing status must not probe identity'));
  assert.equal(workerMayBeAlive({ runDir, now, kill }), false);
  assert.equal(kill.mock.callCount(), 0);
});

test('non-object worker status is false without reading the status file or probing', (t) => {
  const runDir = fixture(t);
  writeJson(runDir, 'status.json', running);
  const kill = t.mock.fn(() => assert.fail('non-object status must not probe identity'));
  const read = t.mock.method(fs, 'readFileSync');
  for (const status of [null, 0, 1, false, true, '', 'running']) {
    assert.equal(workerMayBeAlive({ runDir, status, now, kill }), false);
  }
  assert.equal(kill.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
});

test('undefined worker status reads the finished record and forwards identity options', (t) => {
  const runDir = fixture(t);
  const status = { ...running, state: 'finished' };
  writeJson(runDir, 'status.json', status);
  const kill = t.mock.fn(() => {});
  const probe = t.mock.fn(() => recordedStart);
  assert.equal(workerMayBeAlive({ runDir, status: undefined, now, kill, probe }), true);
  assert.deepEqual(kill.mock.calls[0].arguments, [running.pid, 0]);
  assert.equal(probe.mock.callCount(), 1);
  const [pid, options] = probe.mock.calls[0].arguments;
  assert.equal(pid, running.pid);
  assert.deepEqual(options.status, status);
  assert.equal(options.runDir, runDir);
  assert.equal(options.now, now);
});

test('explicit worker status is passed unchanged without reading status.json', (t) => {
  const runDir = fixture(t);
  writeJson(runDir, 'status.json', { ...running, pid: 0 });
  const status = { ...running, state: 'finished' };
  const read = t.mock.method(fs, 'readFileSync');
  const probe = t.mock.fn(() => recordedStart);
  assert.equal(workerMayBeAlive({ runDir, status, now, kill: () => {}, probe }), true);
  assert.strictEqual(probe.mock.calls[0].arguments[1].status, status);
  assert.equal(read.mock.calls.some(({ arguments: args }) => args[0] === path.join(runDir, 'status.json')), false);
});

test('a matching live process remains running even with a stale heartbeat and readable meta', (t) => {
  const runDir = fixture(t);
  const heartbeatAgeMs = heartbeat(runDir, HEARTBEAT_STALE_MS + 10_000);
  writeJson(runDir, 'meta.json', { status: 'OK' });
  const kill = t.mock.fn(() => {});
  const probe = t.mock.fn(() => recordedStart);
  assert.deepEqual(runLiveness({ runDir, status: running, now, kill, probe }), {
    recordedState: 'running', identity: IDENTITY_ALIVE, processMayBeAlive: true,
    heartbeatAgeMs, state: 'running',
  });
  assert.deepEqual(kill.mock.calls[0].arguments, [running.pid, 0]);
  assert.equal(probe.mock.callCount(), 1);
});

test('an unverified process stays fail-open even with readable meta', (t) => {
  const runDir = fixture(t);
  writeJson(runDir, 'meta.json', { status: 'OK' });
  assert.deepEqual(runLiveness({ runDir, status: running, now, kill: permissionDenied, probe: () => null }), {
    recordedState: 'running', identity: IDENTITY_UNVERIFIED, processMayBeAlive: true,
    heartbeatAgeMs: null, state: 'unverified',
  });
});

for (const identity of [IDENTITY_DEAD, IDENTITY_FOREIGN]) {
  for (const [label, contents, state] of [
    ['absent', undefined, 'abandoned'],
    ['readable', '{"status":"OK","finished_at":"X"}', 'finished'],
    ['half-written', '{', 'unverified'],
    ['null', 'null', 'unverified'],
    ['false', 'false', 'unverified'],
    ['truthy scalar', 'true', 'finished'],
  ]) {
    test(`a ${identity} writer with ${label} meta is ${state} and cannot block another writer`, (t) => {
      const runDir = fixture(t);
      if (contents !== undefined) fs.writeFileSync(path.join(runDir, 'meta.json'), contents);
      assert.deepEqual(runLiveness({
        runDir, status: running, now,
        kill: identity === IDENTITY_DEAD ? noProcess : permissionDenied,
        probe: () => recordedStart + 60_000,
      }), {
        recordedState: 'running', identity, processMayBeAlive: false, heartbeatAgeMs: null, state,
      });
    });
  }
}

test('heartbeat age is reported even without a recorded state or with a closed record', (t) => {
  const runDir = fixture(t);
  assert.equal(runLiveness({ runDir, now }).heartbeatAgeMs, null);
  const heartbeatAgeMs = heartbeat(runDir, 5_000);
  assert.equal(typeof heartbeatAgeMs, 'number');
  assert.deepEqual(runLiveness({ runDir, now }), { ...allNull, heartbeatAgeMs });
  assert.equal(runLiveness({ runDir, status: { state: 'finished' }, now }).heartbeatAgeMs, heartbeatAgeMs);
});

test('injected now controls both heartbeat age and the identity freshness check', (t) => {
  const runDir = fixture(t);
  const age = heartbeat(runDir, 1_000);
  const probe = t.mock.fn(() => recordedStart + 60_000);
  const options = { runDir, status: running, kill: permissionDenied, probe };
  const fresh = runLiveness({ ...options, now });
  assert.equal(fresh.heartbeatAgeMs, age);
  assert.equal(fresh.identity, IDENTITY_ALIVE);
  assert.equal(probe.mock.callCount(), 0);
  const stale = runLiveness({ ...options, now: now + HEARTBEAT_STALE_MS });
  assert.equal(stale.heartbeatAgeMs, age + HEARTBEAT_STALE_MS);
  assert.equal(stale.identity, IDENTITY_FOREIGN);
  assert.equal(probe.mock.callCount(), 1);
});

test('signalZero, processStartProbe, and ignoreHeartbeat injections reach the identity judge', (t) => {
  const runDir = fixture(t);
  heartbeat(runDir, 1_000);
  const signalZero = t.mock.fn(permissionDenied);
  const processStartProbe = t.mock.fn(() => recordedStart + 60_000);
  const result = runLiveness({
    runDir, status: running, now, signalZero, processStartProbe, ignoreHeartbeat: true,
  });
  assert.equal(result.identity, IDENTITY_FOREIGN);
  assert.equal(result.state, 'abandoned');
  assert.deepEqual(signalZero.mock.calls[0].arguments, [running.pid, 0]);
  const [pid, options] = processStartProbe.mock.calls[0].arguments;
  assert.equal(pid, running.pid);
  assert.strictEqual(options.status, running);
  assert.strictEqual(options.signalZero, signalZero);
  assert.strictEqual(options.processStartProbe, processStartProbe);
  assert.equal(options.now, now);
  assert.equal(options.ignoreHeartbeat, true);
});

test('commandRunner remains injectable without calling a real OS process probe', (t) => {
  const runDir = fixture(t);
  const commandRunner = t.mock.fn(() => ({
    status: 0, stdout: new Date(recordedStart).toISOString(),
  }));
  const result = runLiveness({ runDir, status: running, now, kill: permissionDenied, commandRunner });
  assert.equal(result.identity, IDENTITY_ALIVE);
  assert.equal(result.processMayBeAlive, true);
  assert.equal(commandRunner.mock.callCount(), 1);
});

// D27 preserves two independent decisions: broken metadata prevents closing the record,
// but a known-dead writer cannot keep another run out of the tree.
test('run-state leaves unreadable meta untouched without blocking a new writer', (t) => {
  const runsRoot = fixture(t);
  const runDir = path.join(runsRoot, 'dead-writer');
  fs.mkdirSync(runDir);
  writeJson(runDir, 'status.json', { state: 'running', pid: 0, repo: '/repo', agent: 'codex-build' });
  fs.writeFileSync(path.join(runDir, 'meta.json'), '{');
  const before = fs.readFileSync(path.join(runDir, 'status.json'), 'utf8');
  assert.deepEqual(markAbandoned(runsRoot), []);
  assert.equal(activeRunDetails(runsRoot, '/repo'), null);
  assert.equal(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'), '{');
});

test('run-state never re-closes an already finished record', (t) => {
  const runsRoot = fixture(t);
  const runDir = path.join(runsRoot, 'finished');
  fs.mkdirSync(runDir);
  writeJson(runDir, 'status.json', { state: 'finished', status: 'OK', finished_at: 'original', pid: 0 });
  writeJson(runDir, 'meta.json', { status: 'FAIL', finished_at: 'different' });
  const before = fs.readFileSync(path.join(runDir, 'status.json'), 'utf8');
  assert.deepEqual(markAbandoned(runsRoot), []);
  assert.equal(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'), before);
});
