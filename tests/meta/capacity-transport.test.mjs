/** OW-074 C1 recognizes measured capacity failures without changing verdicts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { readEvents } from '../../src/home/lib/meta/events.mjs';
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

test('the verbatim capacity stream selects the measured final transport failure', () => {
  const error = readEvents(makeRun({ events: fixture })).transport_error;

  assert.equal(error.capacity, true);
  assert.equal(error.quota, false);
  assert.equal(error.unavailable, false);
  assert.equal(error.event.type, 'turn.failed');
  assert.deepEqual(error.event, capacityFailure);
});

test('capacity takes priority over the four preceding 503 reconnect errors', () => {
  const data = readEvents(makeRun({ events: reconnectFixture }));
  const reconnects = data.events.filter((event) =>
    event.type === 'error' && event.message.startsWith('Reconnecting...'));

  assert.equal(reconnects.length, 4);
  for (const event of reconnects) assert.match(event.message, /503/);
  assert.equal(data.transport_error.capacity, true);
  assert.equal(data.transport_error.quota, false);
  assert.equal(data.transport_error.unavailable, false);
  assert.deepEqual(data.transport_error.event, capacityFailure);
});

test('quota suppresses capacity even on a matching measured message', () => {
  const events = [{
    type: 'turn.failed',
    error: { message: `${capacityFailure.error.message} quota exhausted` },
  }];
  const error = readEvents(makeRun({ events })).transport_error;

  assert.equal(error.quota, true);
  assert.equal(error.capacity, false);
});

test('quota takes priority over capacity in either stream order', () => {
  const quota = { type: 'turn.failed', error: { status: 429 } };
  for (const events of [[capacityFailure, quota], [quota, capacityFailure]]) {
    const error = readEvents(makeRun({ events })).transport_error;

    assert.equal(error.quota, true);
    assert.equal(error.capacity, false);
    assert.deepEqual(error.event, quota);
  }
});

test('unavailability takes priority over capacity in either stream order', () => {
  const signedOutEvents = fs.readFileSync(
    new URL('./fixtures/codex-0.159-signed-out.events.jsonl', import.meta.url),
    'utf8',
  ).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const signedOut = signedOutEvents.find((event) => event.type === 'turn.failed');
  for (const events of [[capacityFailure, signedOut], [signedOut, capacityFailure]]) {
    const error = readEvents(makeRun({ events })).transport_error;

    assert.equal(error.unavailable, true);
    assert.equal(error.capacity, false);
    assert.deepEqual(error.event, signedOut);
  }
});

test('capacity text in model content cannot prove a transport failure', () => {
  for (const type of ['agent_message', 'error']) {
    const events = [
      { type: 'turn.started' },
      { type: 'item.completed', item: { type, text: capacityFailure.error.message } },
    ];

    assert.equal(readEvents(makeRun({ events })).transport_error, null);
  }
});

test('a matching plain error event cannot prove capacity', () => {
  const event = { type: 'error', message: capacityFailure.error.message };
  const error = readEvents(makeRun({ events: [event] })).transport_error;

  assert.equal(error.capacity, false);
  assert.equal(error.quota, false);
  assert.equal(error.unavailable, false);
  assert.deepEqual(error.event, event);
});

test('unmeasured capacity wording cannot prove capacity', () => {
  for (const message of [
    `Quoted: ${capacityFailure.error.message}`,
    'Selected model is at capacityish',
    'selected model is at capacity',
  ]) {
    const events = [{ type: 'turn.failed', error: { message } }];
    assert.equal(readEvents(makeRun({ events })).transport_error.capacity, false);
  }
});

test('a recovered run with a populated result remains OK', () => {
  const dir = makeRun({ events: fixture, result: buildResult([]) });

  assert.equal(collect(dir, 'codex-build', 0).meta.status, 'OK');
});
