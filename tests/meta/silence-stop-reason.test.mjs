import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { silenceStopReason } from '../../src/home/lib/meta/deadline.mjs';
import { resolveStatus } from '../../src/home/lib/meta/verdict.mjs';

const baseReason = 'run stopped by the silence watchdog';
const fullReason = `${baseReason} after 42000 ms without session activity (threshold 40000 ms)`;
const watchdog = { threshold_ms: 40000, decision: { silence_ms: 42000 } };
const stopped = { stopped_by_silence: true, stop: { watchdog } };
const quota = { type: 'error', message: 'ERROR: rate limit exceeded for this account' };

function makeRun(status, events = [{ type: 'thread.started', thread_id: 'silence-test' }], stderr = '') {
  const dir = makeTempTree('silence-stop-');
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), value, 'utf8');
  if (status !== undefined) write('status.json', JSON.stringify(status));
  write('worker.json', JSON.stringify({ args: ['exec', '--json'] }));
  write('stderr.log', stderr);
  write('events.jsonl', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  write('result.json', '');
  return dir;
}

const verdictOf = (runDir) => resolveStatus({
  runDir, resultOk: false, exit: 1, agent: 'codex-build', result: null,
});

for (const [label, status] of [
  ['status absent', undefined],
  ['flag absent', {}],
  ['flag false', { stopped_by_silence: false }],
  ['flag is a string', { stopped_by_silence: 'true' }],
  ['flag is a number', { stopped_by_silence: 1 }],
]) {
  test(`silenceStopReason returns null with ${label}`, () => {
    assert.equal(silenceStopReason(makeRun(status)), null);
  });
}

test('silenceStopReason names both finite measurements', () => {
  assert.equal(silenceStopReason(makeRun(stopped)), fullReason);
});

test('silenceStopReason omits elapsed silence when the decision is absent', () => {
  const dir = makeRun({ stopped_by_silence: true, stop: { watchdog: { threshold_ms: 40000 } } });
  assert.equal(silenceStopReason(dir), `${baseReason} without session activity (threshold 40000 ms)`);
});

test('silenceStopReason omits the parenthesis when the threshold is absent', () => {
  const dir = makeRun({
    stopped_by_silence: true, stop: { watchdog: { decision: { silence_ms: 42000 } } },
  });
  assert.equal(silenceStopReason(dir), `${baseReason} after 42000 ms without session activity`);
});

for (const [label, status] of [
  ['stop absent', { stopped_by_silence: true }],
  ['watchdog absent', { stopped_by_silence: true, stop: {} }],
  ['both measurements absent', { stopped_by_silence: true, stop: { watchdog: {} } }],
]) {
  test(`silenceStopReason keeps the cause with ${label}`, () => {
    assert.equal(silenceStopReason(makeRun(status)), `${baseReason} without session activity`);
  });
}

for (const invalid of [null, '42000', 'Infinity', true]) {
  test(`silenceStopReason omits non-finite silence ${JSON.stringify(invalid)}`, () => {
    const dir = makeRun({
      stopped_by_silence: true,
      stop: { watchdog: { threshold_ms: 40000, decision: { silence_ms: invalid } } },
    });
    assert.equal(silenceStopReason(dir), `${baseReason} without session activity (threshold 40000 ms)`);
  });
  test(`silenceStopReason omits non-finite threshold ${JSON.stringify(invalid)}`, () => {
    const dir = makeRun({
      stopped_by_silence: true,
      stop: { watchdog: { threshold_ms: invalid, decision: { silence_ms: 42000 } } },
    });
    assert.equal(silenceStopReason(dir), `${baseReason} after 42000 ms without session activity`);
  });
}

test('silenceStopReason retains finite zero measurements', () => {
  const dir = makeRun({
    stopped_by_silence: true,
    stop: { watchdog: { threshold_ms: 0, decision: { silence_ms: 0 } } },
  });
  assert.equal(silenceStopReason(dir), `${baseReason} after 0 ms without session activity (threshold 0 ms)`);
});

test('Plan_15: a quoted stderr reason without the runner flag proves no silence stop', () => {
  assert.equal(silenceStopReason(makeRun({}, undefined, fullReason)), null);
});

test('an empty exit-1 result without a stop still takes the empty-result branch', () => {
  assert.deepEqual(verdictOf(makeRun({})), { status: 'FAIL', reason: 'result is empty, exit=1' });
});

// Plan_80 E15/O4b: killed runs arrive empty; stop facts must outrank empty results and LIMIT.
for (const [label, events] of [
  ['an empty result', undefined],
  ['a quota error event', [quota]],
]) {
  test(`a silence stop outranks ${label}`, () => {
    assert.deepEqual(verdictOf(makeRun(stopped, events)), { status: 'FAIL', reason: fullReason });
  });
  test(`the deadline backstop wins over a silence stop with ${label}`, () => {
    const dir = makeRun({ ...stopped, stopped_on_deadline: true, elapsed_ms: 60012 }, events);
    assert.deepEqual(verdictOf(dir), { status: 'FAIL', reason: 'run stopped on its deadline after 60012 ms' });
  });
}

test('without a runner stop flag the same quota event still yields LIMIT', () => {
  const verdict = verdictOf(makeRun({}, [quota]));
  assert.equal(verdict.status, 'LIMIT');
  assert.match(verdict.reason, /rate limit/);
});
