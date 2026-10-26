/** OW-074 C2 gives measured capacity failures their own status and runner code. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collect, exitCodeFor } from '../../src/home/lib/write-meta.mjs';
import { EXIT } from '../../src/home/lib/runner/exit-codes.mjs';
import { buildResult, makeRun } from './test-fixtures.mjs';

const fixture = fs.readFileSync(
  new URL('./fixtures/codex-0.160-model-capacity.events.jsonl', import.meta.url),
  'utf8',
);
const reconnectFixture = fs.readFileSync(
  new URL('./fixtures/codex-0.160-model-capacity-after-reconnect.events.jsonl', import.meta.url),
  'utf8',
);
const fixtureEvents = fixture.trim().split(/\r?\n/).map((line) => JSON.parse(line));
const capacityFailure = fixtureEvents.find((event) => event.type === 'turn.failed');

test('the verbatim capacity stream with an empty result is CAPACITY with runner code 6', () => {
  const dir = makeRun({ events: fixture });
  const { meta } = collect(dir, 'codex-build', 1);

  assert.equal(meta.status, 'CAPACITY');
  assert.equal(meta.exit, 1);
  assert.match(meta.reason, /Selected model is at capacity/);
  assert.equal(EXIT.CAPACITY, 6);
  assert.equal(exitCodeFor(meta.status), EXIT.CAPACITY);
});

test('capacity after reconnect errors with an empty result is CAPACITY', () => {
  const dir = makeRun({ events: reconnectFixture });

  assert.equal(collect(dir, 'codex-build', 1).meta.status, 'CAPACITY');
});

test('a recovered run ignores the capacity transport failure', () => {
  const dir = makeRun({ events: fixture, result: buildResult([]) });

  assert.equal(collect(dir, 'codex-build', 0).meta.status, 'OK');
});

test('quota takes priority on a capacity turn failure that also says quota', () => {
  const events = [{
    type: 'turn.failed',
    error: { message: `${capacityFailure.error.message} quota exhausted` },
  }];
  const dir = makeRun({ events });

  assert.equal(collect(dir, 'codex-build', 1).meta.status, 'LIMIT');
});

test('an unknown status is a programming error instead of a FAIL runner code', () => {
  assert.throws(() => exitCodeFor('UNKNOWN'), { message: 'unknown run status "UNKNOWN"' });
});
