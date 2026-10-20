/** Plan_80 E12/E16 requires conservative, double-read, one-decision stall detection. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { createSilenceWatchdog, stallVerdict } from '../../src/home/lib/runner/silence-watchdog.mjs';

const START = '2026-10-17T10:00:00.000Z';
const REFERENCE = '2026-10-17T10:20:00.000Z';
const CONFIRMED = '2026-10-17T10:20:01.000Z';
const THRESHOLD = 996000;
const THREAD = 'silence-watchdog-test-thread';
const activity = ({ state = 'observed', commands = 'none', last = START } = {}) => ({
  state, at_reference: { last_record_at: last, commands: { state: commands } },
});
const verdict = (value, referenceAt = REFERENCE) => stallVerdict({
  activity: value, referenceAt, thresholdMs: THRESHOLD,
});

function fixture({ thread = true } = {}) {
  const runDir = makeTempTree('silence-watchdog-');
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({ started_at: START }));
  if (thread) {
    fs.writeFileSync(path.join(runDir, 'events.jsonl'),
      `${JSON.stringify({ type: 'thread.started', thread_id: THREAD })}\n`);
  }
  return runDir;
}

function detector({ arming = 'shadow', observations = [activity(), activity()],
  times = [REFERENCE, CONFIRMED], runDir = fixture(), ...options } = {}) {
  const reads = [];
  let ticks = 0;
  const watchdog = createSilenceWatchdog({
    runDir, arming, thresholdMs: THRESHOLD,
    now: () => new Date(times[ticks++]),
    read: (args) => {
      reads.push(args);
      return observations[reads.length - 1];
    },
    ...options,
  });
  return { watchdog, reads, runDir, ticks: () => ticks };
}

test('only observed, command-free silence at or above the threshold is a stall', () => {
  const atThreshold = new Date(Date.parse(START) + THRESHOLD).toISOString();
  assert.deepEqual(verdict(activity(), atThreshold), {
    stall: true, silence_ms: THRESHOLD, reason: 'threshold-reached',
  });
  assert.equal(verdict(activity()).stall, true);
  const healthyAt = new Date(Date.parse(START) + 855163).toISOString();
  assert.deepEqual(verdict(activity(), healthyAt), {
    stall: false, silence_ms: 855163, reason: 'below-threshold',
  });
  assert.equal(verdict(activity(), new Date(Date.parse(atThreshold) - 1).toISOString()).stall, false);
});

test('every unobserved state and uncertain command state prevents a stall', () => {
  for (const state of ['missing', 'unreadable', 'incomplete', 'unrecognized', 'not-observed', 'empty']) {
    const result = verdict(activity({ state }));
    assert.equal(result.stall, false, state);
    assert.equal(result.reason, state);
  }
  for (const commands of ['in-flight', 'unknown', null]) {
    const result = verdict(activity({ commands }));
    assert.equal(result.stall, false, String(commands));
    assert.equal(result.silence_ms, 1200000);
    assert.match(result.reason, /^commands-/);
  }
});

test('null silence, absent reference evidence, and invalid times cannot prove a stall', () => {
  for (const value of [activity({ last: null }), { state: 'observed', at_reference: null },
    { state: 'observed' }, null]) {
    assert.equal(verdict(value).stall, false);
    assert.equal(verdict(value).silence_ms, null);
  }
  assert.equal(verdict(activity(), 'invalid').stall, false);
  assert.equal(verdict(activity(), '2026-10-17T09:59:59.000Z').silence_ms, null);
  const evidence = activity();
  evidence.at_reference.commands.reason = 'session incomplete';
  assert.equal(verdict(evidence).stall, false);
  assert.equal(verdict(evidence).silence_ms, null);
});

test('a fresh confirmation record cancels the decision and permits later checks', () => {
  const fresh = activity({ last: CONFIRMED });
  const { watchdog, reads } = detector({ observations: [activity(), fresh, fresh],
    times: [REFERENCE, CONFIRMED, '2026-10-17T10:20:02.000Z'] });
  assert.equal(watchdog.check(), 'none');
  assert.equal(reads.length, 2);
  assert.equal(watchdog.record().decision, null);
  assert.equal(watchdog.record().checks, 2);
  assert.deepEqual(watchdog.record().last_observation, {
    at: CONFIRMED, state: 'observed', commands: 'none', silence_ms: 0,
  });
  assert.equal(watchdog.check(), 'none');
  assert.equal(reads.length, 3);
  assert.equal(watchdog.record().checks, 3);
  assert.equal(watchdog.record().last_observation.silence_ms, 1000);
});

for (const arming of ['shadow']) {
  test(`${arming} confirms a stall exactly once and records both reference times`, () => {
    const { watchdog, reads, ticks } = detector({ arming });
    assert.equal(watchdog.arming, arming);
    assert.equal(watchdog.intervalMs, 30000);
    assert.deepEqual(watchdog.record(), {
      version: 1, arming, threshold_ms: THRESHOLD, interval_ms: 30000,
      checks: 0, last_observation: null, decision: null, fault: null,
    });
    assert.equal(watchdog.check(), 'none');
    assert.deepEqual(reads, [
      { threadId: THREAD, startedAt: START, referenceAt: REFERENCE },
      { threadId: THREAD, startedAt: START, referenceAt: CONFIRMED },
    ]);
    assert.deepEqual(watchdog.record(), {
      version: 1, arming, threshold_ms: THRESHOLD, interval_ms: 30000, checks: 2,
      last_observation: { at: CONFIRMED, state: 'observed', commands: 'none', silence_ms: 1201000 },
      decision: { at: REFERENCE, silence_ms: 1200000, confirmed_at: CONFIRMED,
        action: 'recorded' }, fault: null,
    });
    const frozen = watchdog.record();
    assert.equal(watchdog.check(), 'none');
    assert.equal(watchdog.check(), 'none');
    assert.equal(reads.length, 2);
    assert.equal(ticks(), 2);
    assert.deepEqual(watchdog.record(), frozen);
  });
}

test('incomplete or uncertain confirmation evidence prevents a decision', () => {
  for (const second of [activity({ state: 'incomplete' }), activity({ commands: 'in-flight' }),
    activity({ commands: 'unknown' }), activity({ last: null })]) {
    const { watchdog, reads } = detector({ observations: [activity(), second] });
    assert.equal(watchdog.check(), 'none');
    assert.equal(reads.length, 2);
    assert.equal(watchdog.record().decision, null);
  }
});

test('non-stall reads are counted once and preserve the latest observation', () => {
  const { watchdog, reads } = detector({ observations: [{ state: 'missing', at_reference: null }], intervalMs: 750 });
  assert.equal(watchdog.intervalMs, 750);
  assert.equal(watchdog.check(), 'none');
  assert.equal(reads.length, 1);
  assert.deepEqual(watchdog.record(), {
    version: 1, arming: 'shadow', threshold_ms: THRESHOLD, interval_ms: 750, checks: 1,
    last_observation: { at: REFERENCE, state: 'missing', commands: null, silence_ms: null },
    decision: null, fault: null,
  });
});

test('thread discovery retries without log or clock reads until the id appears', () => {
  const { watchdog, reads, runDir, ticks } = detector({ runDir: fixture({ thread: false }) });
  assert.equal(watchdog.check(), 'none');
  assert.equal(watchdog.check(), 'none');
  assert.equal(reads.length, 0);
  assert.equal(ticks(), 0);
  assert.equal(watchdog.record().checks, 0);
  assert.equal(watchdog.record().last_observation, null);
  fs.writeFileSync(path.join(runDir, 'events.jsonl'),
    `${JSON.stringify({ type: 'thread.started', thread_id: THREAD })}\n`);
  assert.equal(watchdog.check(), 'none');
  assert.equal(reads.length, 2);
  assert.equal(watchdog.record().decision.action, 'recorded');
});

test('the discovered thread and start time are cached across checks', () => {
  const fresh = activity({ last: REFERENCE });
  const { watchdog, reads, runDir } = detector({ observations: [fresh, fresh] });
  assert.equal(watchdog.check(), 'none');
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), 'invalid after discovery\n');
  fs.writeFileSync(path.join(runDir, 'status.json'), 'invalid after first read');
  assert.equal(watchdog.check(), 'none');
  assert.deepEqual(reads.map(({ threadId, startedAt }) => ({ threadId, startedAt })), [
    { threadId: THREAD, startedAt: START }, { threadId: THREAD, startedAt: START },
  ]);
  assert.equal(watchdog.record().checks, 2);
});

test('off reads no files, session activity or clock and preserves the given threshold', () => {
  for (const thresholdMs of [null, THRESHOLD]) {
    const unexpected = () => assert.fail('off arming must not read');
    const watchdog = createSilenceWatchdog({
      runDir: null, arming: 'off', thresholdMs, intervalMs: 1, now: unexpected, read: unexpected,
    });
    assert.equal(watchdog.arming, 'off');
    assert.equal(watchdog.intervalMs, null);
    assert.equal(watchdog.check(), 'none');
    assert.equal(watchdog.check(), 'none');
    assert.deepEqual(watchdog.record(), {
      version: 1, arming: 'off', threshold_ms: thresholdMs, interval_ms: null,
      checks: 0, last_observation: null, decision: null, fault: null,
    });
  }
});

test('Plan_80 E25: armed is refused because silence-based stopping is retired', () => {
  assert.throws(() => createSilenceWatchdog({ arming: 'armed', thresholdMs: THRESHOLD }),
    /Plan_80 E25: silence-based stopping is retired/);
});

test('invalid arming values and non-positive or non-integer active thresholds fail loudly', () => {
  for (const arming of [undefined, null, 'SHADOW', 'invalid', false]) {
    assert.throws(() => createSilenceWatchdog({ arming, thresholdMs: THRESHOLD }),
      /arming: expected off or shadow; Plan_80 E25: silence-based stopping is retired/);
  }
  for (const arming of ['shadow']) {
    for (const thresholdMs of [undefined, null, 0, -1, 0.5, '996000', NaN, Infinity]) {
      assert.throws(() => createSilenceWatchdog({ arming, thresholdMs }), /positive integer/);
    }
  }
});

test('Plan_80 B1b1: a reader fault is recorded once and disables further reads', () => {
  for (const failOn of [1, 2]) {
    let reads = 0;
    const { watchdog } = detector({ arming: 'shadow', read: () => {
      reads++;
      if (reads === failOn) throw new TypeError('session reader failed');
      return activity();
    } });
    assert.equal(watchdog.check(), 'none');
    assert.equal(watchdog.record().fault, 'session reader failed');
    assert.equal(watchdog.record().decision, null);
    assert.equal(watchdog.record().checks, failOn - 1);
    const frozen = watchdog.record();
    assert.equal(watchdog.check(), 'none');
    assert.equal(reads, failOn);
    assert.deepEqual(watchdog.record(), frozen);
  }
});

test('an unreadable status records a fault and never retries discovery or the reader', (t) => {
  const runDir = fixture();
  const status = path.join(runDir, 'status.json');
  const originalRead = fs.readFileSync;
  let statusReads = 0;
  const readFile = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === status) {
      statusReads++;
      throw new Error('status is unreadable');
    }
    return originalRead(file, ...args);
  });
  const { watchdog, reads, ticks } = detector({ runDir });
  assert.equal(watchdog.check(), 'none');
  assert.match(watchdog.record().fault, /status is unreadable/);
  const calls = readFile.mock.calls.length;
  assert.equal(watchdog.check(), 'none');
  assert.equal(readFile.mock.calls.length, calls);
  assert.equal(statusReads, 1);
  assert.equal(reads.length, 0);
  assert.equal(ticks(), 0);
});
