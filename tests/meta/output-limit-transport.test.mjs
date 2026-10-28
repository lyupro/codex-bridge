/** OW-078 B1 recognizes measured output-limit failures and Codex-failed turns without changing verdicts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { readEvents } from '../../src/home/lib/meta/events.mjs';
import { buildResult, makeRun } from './test-fixtures.mjs';

const fixture = fs.readFileSync(
  new URL('./fixtures/codex-0.164-output-limit.events.jsonl', import.meta.url),
  'utf8',
);
const fixtureEvents = fixture.trim().split(/\r?\n/).map((line) => JSON.parse(line));
const outputFailure = fixtureEvents.find((event) => event.type === 'turn.failed');

test('the verbatim output-limit stream selects the measured final transport failure', () => {
  const data = readEvents(makeRun({ events: fixture }));
  const error = data.transport_error;

  assert.equal(error.output_limit, true);
  assert.equal(error.capacity, false);
  assert.equal(error.quota, false);
  assert.equal(error.unavailable, false);
  assert.equal(error.event.type, 'turn.failed');
  assert.deepEqual(error.event, outputFailure);
  assert.equal(data.turn_failed, true);
});

test('output limits take priority over a preceding 503 reconnect error', () => {
  const events = [
    { type: 'error', message: 'Reconnecting... 2/5 (unexpected status 503 Service Unavailable)' },
    ...fixtureEvents,
  ];
  const error = readEvents(makeRun({ events })).transport_error;

  assert.equal(error.output_limit, true);
  assert.deepEqual(error.event, outputFailure);
});

test('quota suppresses output limits even on a matching measured message', () => {
  for (const error of [
    { message: `${outputFailure.error.message} quota exhausted` },
    { message: `${outputFailure.error.message} status 429` },
  ]) {
    const transport = readEvents(makeRun({ events: [{ type: 'turn.failed', error }] })).transport_error;

    assert.equal(transport.quota, true);
    assert.equal(transport.output_limit, false);
  }
});

test('quota, unavailability and capacity take priority over output limits in either stream order', () => {
  const quota = { type: 'turn.failed', error: { status: 429 } };
  const samples = [
    { event: quota, flag: 'quota' },
    ...[
      ['codex-0.159-signed-out.events.jsonl', 'unavailable'],
      ['codex-0.160-model-capacity.events.jsonl', 'capacity'],
    ].map(([file, flag]) => ({
      event: fs.readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')
        .trim().split(/\r?\n/).map((line) => JSON.parse(line))
        .find((event) => event.type === 'turn.failed'),
      flag,
    })),
  ];
  for (const { event, flag } of samples) {
    for (const events of [[outputFailure, event], [event, outputFailure]]) {
      const error = readEvents(makeRun({ events })).transport_error;

      assert.equal(error[flag], true);
      assert.equal(error.output_limit, false);
      assert.deepEqual(error.event, event);
    }
  }
});

test('output-limit text in model content cannot prove a transport failure', () => {
  for (const type of ['agent_message', 'error']) {
    const events = [
      { type: 'turn.started' },
      { type: 'item.completed', item: { type, text: outputFailure.error.message } },
    ];
    const data = readEvents(makeRun({ events }));

    assert.equal(data.transport_error, null);
    assert.equal(data.turn_failed, false);
  }
});

test('a matching plain error event cannot prove an output limit or a failed turn', () => {
  const event = { type: 'error', message: outputFailure.error.message };
  const data = readEvents(makeRun({ events: [event] }));

  assert.equal(data.transport_error.output_limit, false);
  assert.equal(data.transport_error.capacity, false);
  assert.equal(data.transport_error.quota, false);
  assert.equal(data.transport_error.unavailable, false);
  assert.deepEqual(data.transport_error.event, event);
  assert.equal(data.turn_failed, false);
});

test('unmeasured output-limit wording cannot prove an output limit', () => {
  for (const message of [
    `Quoted: ${outputFailure.error.message}`,
    'Incomplete response returned, reason: max_output_tokens_extra',
    'incomplete response returned, reason: max_output_tokens',
  ]) {
    const data = readEvents(makeRun({ events: [{ type: 'turn.failed', error: { message } }] }));

    assert.equal(data.transport_error.output_limit, false);
    assert.equal(data.turn_failed, true);
  }
});

test('an unknown Codex failure still marks the turn as failed', () => {
  const events = [{ type: 'turn.failed', error: { message: 'Unknown turn failure' } }];
  const data = readEvents(makeRun({ events }));

  assert.equal(data.turn_failed, true);
  assert.equal(data.transport_error.output_limit, false);
});

test('the last turn-terminal event determines turn_failed', () => {
  const completed = { type: 'turn.completed' };
  for (const events of [[completed], [outputFailure, completed]]) {
    assert.equal(readEvents(makeRun({ events })).turn_failed, false);
  }
  for (const events of [
    [completed, outputFailure],
    [outputFailure, { type: 'turn.started' }, { type: 'error', message: 'Later diagnostic' }],
  ]) {
    assert.equal(readEvents(makeRun({ events })).turn_failed, true);
  }
});

test('empty and missing streams have no failed turn', () => {
  for (const events of [[], null]) {
    assert.equal(readEvents(makeRun({ events })).turn_failed, false);
  }
});

test('a failed result remains FAIL through collect despite output-limit detection', () => {
  const result = buildResult([], { outcome: 'fail', summary: 'Output ceiling prevented completion' });
  const dir = makeRun({ events: fixture, result });

  assert.equal(collect(dir, 'codex-build', 1).meta.status, 'FAIL');
});

test('a recovered run with a populated result remains OK', () => {
  const dir = makeRun({ events: fixture, result: buildResult([]) });

  assert.equal(collect(dir, 'codex-build', 0).meta.status, 'OK');
});
