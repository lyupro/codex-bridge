/** Plan_60 D2 classifies only measured CLI transport failures, never quoted authentication text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { readEvents } from '../../src/home/lib/meta/events.mjs';
import { buildResult, makeRun } from './test-fixtures.mjs';

const fixture = fs.readFileSync(
  new URL('./fixtures/codex-0.159-signed-out.events.jsonl', import.meta.url),
  'utf8',
);
const fixtureEvents = fixture.trim().split(/\r?\n/).map((line) => JSON.parse(line));
const signedOut = fixtureEvents.find((event) => event.type === 'turn.failed');

test('the verbatim signed-out stream with an empty result is UNAVAILABLE', () => {
  const dir = makeRun({ events: fixture });
  const { meta } = collect(dir, 'codex-build', 1);

  assert.equal(meta.status, 'UNAVAILABLE');
  assert.match(meta.reason, /401 Unauthorized/);
  assert.equal(meta.reason, readEvents(dir).transport_error.reason);
});

test('a recovered run ignores the signed-out transport failure', () => {
  const dir = makeRun({ events: fixture, result: buildResult([]) });
  const { meta } = collect(dir, 'codex-build', 0);

  assert.equal(meta.status, 'OK');
});

test('reconnection errors without the final turn failure stay FAIL', () => {
  const events = fixtureEvents.filter((event) =>
    event.type === 'error' && event.message.startsWith('Reconnecting...'));
  const dir = makeRun({ events });

  assert.equal(collect(dir, 'codex-build', 1).meta.status, 'FAIL');
  assert.equal(readEvents(dir).transport_error.unavailable, false);
});

test('an unmeasured invalid-token turn failure stays FAIL with its CLI reason', () => {
  const message = 'unexpected status 401 Unauthorized: invalid token';
  const dir = makeRun({ events: [{ type: 'turn.failed', error: { message } }] });
  const { meta } = collect(dir, 'codex-build', 1);

  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason, message);
  assert.equal(readEvents(dir).transport_error.unavailable, false);
});

test('quota takes priority over a signed-out turn failure in either stream order', () => {
  const quota = { type: 'turn.failed', error: { status: 429 } };
  for (const events of [[signedOut, quota], [quota, signedOut]]) {
    const dir = makeRun({ events });
    const { meta } = collect(dir, 'codex-build', 1);
    const error = readEvents(dir).transport_error;

    assert.equal(meta.status, 'LIMIT');
    assert.equal(error.quota, true);
    assert.equal(error.unavailable, false);
    assert.equal(meta.reason, error.reason);
  }
});

test('readEvents selects the measured final failure from the verbatim fixture', () => {
  const error = readEvents(makeRun({ events: fixture })).transport_error;

  assert.equal(error.unavailable, true);
  assert.equal(error.quota, false);
  assert.equal(error.event.type, 'turn.failed');
  assert.deepEqual(error.event, signedOut);
});

test('a matching plain error event cannot prove unavailability', () => {
  const events = [{ type: 'error', message: signedOut.error.message }];
  const dir = makeRun({ events });

  assert.equal(collect(dir, 'codex-build', 1).meta.status, 'FAIL');
  assert.equal(readEvents(dir).transport_error.unavailable, false);
});

test('bare authentication statuses and quoted content cannot prove unavailability', () => {
  for (const status of [401, 403]) {
    const events = [{ type: 'turn.failed', error: { status } }];
    const dir = makeRun({ events });
    assert.equal(collect(dir, 'codex-build', 1).meta.status, 'FAIL');
    assert.equal(readEvents(dir).transport_error.unavailable, false);
  }
  const dir = makeRun({ events: [
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'error', message: signedOut.error.message } },
  ] });
  assert.equal(collect(dir, 'codex-build', 1).meta.status, 'FAIL');
  assert.equal(readEvents(dir).transport_error, null);
});

test('quota suppresses unavailability even on a matching measured message', () => {
  const events = [{ type: 'turn.failed', error: { status: 429, error: { message: signedOut.error.message } } }];
  const dir = makeRun({ events });
  const error = readEvents(dir).transport_error;

  assert.equal(error.quota, true);
  assert.equal(error.unavailable, false);
  assert.equal(collect(dir, 'codex-build', 1).meta.status, 'LIMIT');
});
