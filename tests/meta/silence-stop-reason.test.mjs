/**
 * Plan_80 E28: silence stopping was never armed, so its retired flag cannot prove a stop.
 * Deadline evidence still outranks empty results and quota errors (Plan_80 E15/O4b).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import * as deadline from '../../src/home/lib/meta/deadline.mjs';
import { resolveStatus } from '../../src/home/lib/meta/verdict.mjs';

const retiredFlag = { stopped_by_silence: true };
const retiredWatchdog = {
  ...retiredFlag,
  stop: { watchdog: { threshold_ms: 40000, decision: { silence_ms: 42000 } } },
};
const quota = { type: 'error', message: 'ERROR: rate limit exceeded for this account' };

function makeRun(status, events = [{ type: 'thread.started', thread_id: 'silence-test' }]) {
  const dir = makeTempTree('silence-stop-');
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), value, 'utf8');
  if (status !== undefined) write('status.json', JSON.stringify(status));
  write('worker.json', JSON.stringify({ args: ['exec', '--json'] }));
  write('stderr.log', '');
  write('events.jsonl', events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  write('result.json', '');
  return dir;
}

const verdictOf = (runDir) => resolveStatus({
  runDir, resultOk: false, exit: 1, agent: 'codex-build', result: null,
});

test('Plan_80 E28: deadline module no longer exports silenceStopReason', () => {
  assert.equal(Object.hasOwn(deadline, 'silenceStopReason'), false);
});

for (const [label, status] of [
  ['flag alone', retiredFlag],
  ['flag with watchdog measurements', retiredWatchdog],
]) {
  test(`Plan_80 E28: ${label} cannot override quota evidence`, () => {
    const baseline = verdictOf(makeRun({}, [quota]));
    assert.equal(baseline.status, 'LIMIT');
    assert.match(baseline.reason, /rate limit/);
    assert.deepEqual(verdictOf(makeRun(status, [quota])), baseline);
  });

  test(`Plan_80 E28: ${label} without other evidence produces no silence reason`, () => {
    const baseline = verdictOf(makeRun({}));
    assert.deepEqual(baseline, { status: 'FAIL', reason: 'result is empty, exit=1' });
    const dir = makeRun(status);
    assert.equal(deadline.deadlineReason(dir), null);
    assert.deepEqual(verdictOf(dir), baseline);
  });
}

for (const [label, events] of [
  ['an empty result', undefined],
  ['a quota error event', [quota]],
]) {
  for (const [elapsedLabel, elapsed, reason] of [
    ['finite elapsed time', { elapsed_ms: 60012 }, 'run stopped on its deadline after 60012 ms'],
    ['no elapsed time', {}, 'run stopped on its deadline'],
  ]) {
    test(`Plan_80 E28: deadline with ${elapsedLabel} still outranks ${label}`, () => {
      for (const status of [{}, retiredFlag, retiredWatchdog]) {
        const dir = makeRun({ ...status, stopped_on_deadline: true, ...elapsed }, events);
        assert.equal(deadline.deadlineReason(dir), reason);
        assert.deepEqual(verdictOf(dir), { status: 'FAIL', reason });
      }
    });
  }
}
