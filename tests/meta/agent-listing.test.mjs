import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { dispatcherPresence, sessionAgentTypes } from '../../src/home/lib/agent-listing.mjs';

const latePath = fileURLToPath(new URL('./fixtures/claude-2.1.304-agent-listing-late.jsonl', import.meta.url));
const healthyPath = fileURLToPath(new URL('./fixtures/claude-2.1.310-agent-listing-healthy.jsonl', import.meta.url));
const lateText = fs.readFileSync(latePath, 'utf8');
const lateEntries = lateText.trimEnd().split(/\r?\n/).map(line => JSON.parse(line));
const healthyEntries = fs.readFileSync(healthyPath, 'utf8').trimEnd().split(/\r?\n/).map(line => JSON.parse(line));
const sessionId = lateEntries[0].sessionId;
const healthySessionId = healthyEntries[0].sessionId;
const initial = lateEntries[1];
const delta = lateEntries[2];
const dispatchers = ['codex-advisor', 'codex-build', 'codex-review', 'codex-scout'];

function replay(entries, overrides = {}) {
  return sessionAgentTypes({
    transcriptPath: latePath, sessionId,
    readFile: () => entries.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n',
    ...overrides,
  });
}

function listingWith(changes, entry = initial) {
  return { ...entry, attachment: { ...entry.attachment, ...changes } };
}

test('late fixture replays both listings and returns frozen, sorted, unique types', () => {
  const result = sessionAgentTypes({ transcriptPath: latePath, sessionId });
  assert.equal(result.state, 'known');
  assert.equal(dispatcherPresence(result, 'codex-build'), 'present');
  assert.equal(result.records, 2);
  assert.equal(result.observedAt, delta.timestamp);
  assert.ok(Object.isFrozen(result.types));
  assert.deepEqual(result.types, [...new Set(result.types)].sort());
});

test('initial late listing proves dispatcher absence while retaining built-ins', () => {
  const result = sessionAgentTypes({
    transcriptPath: latePath, sessionId,
    readFile: () => lateText.split(/\r?\n/).slice(0, 2).join('\n'),
  });
  assert.equal(dispatcherPresence(result, 'codex-build'), 'absent');
  assert.equal(dispatcherPresence(result, 'Explore'), 'present');
  assert.equal(result.records, 1);
  assert.equal(result.observedAt, initial.timestamp);
});

test('healthy fixture lists all four dispatchers even though a user record comes first', () => {
  assert.equal(healthyEntries[0].type, 'user');
  const result = sessionAgentTypes({ transcriptPath: healthyPath, sessionId: healthySessionId });
  for (const dispatcher of dispatchers) assert.equal(dispatcherPresence(result, dispatcher), 'present');
  assert.equal(result.records, 1);
  assert.equal(result.observedAt, healthyEntries[1].timestamp);
});

test('wrong session has unknown presence, never proven absence', () => {
  const result = sessionAgentTypes({ transcriptPath: latePath, sessionId: 'another-session' });
  assert.deepEqual(result, { state: 'unknown', reason: 'no-listing-record' });
  assert.equal(dispatcherPresence(result, 'codex-build'), 'unknown');
  assert.equal(dispatcherPresence(undefined, 'codex-build'), 'unknown');
});

test('boundary failures have distinct reasons and never throw', () => {
  const base = { transcriptPath: latePath, sessionId };
  const failures = [
    sessionAgentTypes({ sessionId }),
    sessionAgentTypes({ transcriptPath: latePath }),
    sessionAgentTypes({ ...base, readFile: () => { throw new Error('unreadable'); } }),
    sessionAgentTypes({ ...base, maxBytes: 10 }),
    sessionAgentTypes({ ...base, maxBytes: -1 }),
  ];
  assert.deepEqual(failures.map(result => result.reason), [
    'invalid-transcript-path', 'invalid-session-id', 'unreadable-file', 'file-too-large', 'invalid-max-bytes',
  ]);
  assert.ok(failures.every(result => result.state === 'unknown'));
  assert.equal(new Set(failures.map(result => result.reason)).size, failures.length);
  assert.equal(sessionAgentTypes().reason, 'invalid-transcript-path');
  assert.equal(sessionAgentTypes(null).reason, 'invalid-transcript-path');
});

for (const value of [undefined, null, '', '  ', 42, {}]) {
  test(`invalid path and session input: ${JSON.stringify(value)}`, () => {
    assert.equal(sessionAgentTypes({ transcriptPath: value, sessionId }).reason, 'invalid-transcript-path');
    assert.equal(sessionAgentTypes({ transcriptPath: latePath, sessionId: value }).reason, 'invalid-session-id');
  });
}

test('stat runs before read and refuses oversize files without reading', () => {
  const calls = [];
  const result = sessionAgentTypes({
    transcriptPath: latePath, sessionId, maxBytes: 10,
    stat: path => { calls.push(['stat', path]); return { size: 11 }; },
    readFile: () => { assert.fail('oversize file must not be read'); },
  });
  assert.equal(result.reason, 'file-too-large');
  assert.deepEqual(calls, [['stat', latePath]]);
});

test('stat failure is unknown and does not read the file', () => {
  const result = sessionAgentTypes({
    transcriptPath: latePath, sessionId,
    stat: () => { throw new Error('missing file'); },
    readFile: () => { assert.fail('failed stat must prevent reading'); },
  });
  assert.equal(result.reason, 'unreadable-file');
});

for (const changes of [
  { addedTypes: 'codex-build' }, { addedTypes: ['Explore', 1] }, { addedTypes: null },
  { removedTypes: 'Explore' }, { removedTypes: [false] }, { removedTypes: undefined },
  { isInitial: 'true' }, { isInitial: undefined },
]) {
  test(`malformed listing fails closed to unknown: ${JSON.stringify(changes)}`, () => {
    assert.deepEqual(replay([listingWith(changes)]), { state: 'unknown', reason: 'invalid-listing-record' });
  });
}

test('a malformed later listing invalidates an otherwise valid initial listing', () => {
  assert.equal(replay([initial, listingWith({ addedTypes: 'codex-build' }, delta)]).reason, 'invalid-listing-record');
});

test('a non-initial listing before the initial listing is unknown', () => {
  assert.deepEqual(replay([delta, initial]), { state: 'unknown', reason: 'non-initial-before-initial' });
});

test('deltas add then remove types, with removal winning within the same record', () => {
  const result = replay([initial, delta, listingWith({
    addedTypes: ['codex-build', 'new-agent'], removedTypes: ['codex-build', 'Explore'],
  }, delta)]);
  assert.equal(dispatcherPresence(result, 'codex-build'), 'absent');
  assert.equal(dispatcherPresence(result, 'Explore'), 'absent');
  assert.equal(dispatcherPresence(result, 'new-agent'), 'present');
  assert.equal(result.records, 3);
});

test('a subsequent initial listing resets the set in file order, not timestamp order', () => {
  const replacement = { ...listingWith({ addedTypes: ['only-agent'], removedTypes: [] }), timestamp: '2000-01-01T00:00:00Z' };
  const result = replay([initial, delta, replacement]);
  assert.deepEqual(result.types, ['only-agent']);
  assert.equal(result.records, 3);
  assert.equal(result.observedAt, replacement.timestamp);
});

test('other sessions and non-listing records cannot change or invalidate this session', () => {
  const result = replay([
    { ...listingWith({ addedTypes: 'invalid' }, delta), sessionId: 'other-session' },
    initial, { ...initial, type: 'user' },
    { ...initial, attachment: { type: 'other-attachment' } },
    { ...delta, sessionId: 'other-session' },
    'unrelated malformed JSON', null,
  ]);
  assert.equal(result.state, 'known');
  assert.equal(result.records, 1);
  assert.equal(dispatcherPresence(result, 'codex-build'), 'absent');
  assert.equal(replay([healthyEntries[1]]).reason, 'no-listing-record');
});

test('garbled middle listing line is unknown even if a later initial listing exists', () => {
  assert.deepEqual(replay([initial, '{"agent_listing_delta":', delta]), {
    state: 'unknown', reason: 'malformed-listing-json',
  });
});

test('garbled final listing line with a newline is unknown', () => {
  assert.equal(replay([initial, '{"agent_listing_delta":']).reason, 'malformed-listing-json');
});

test('garbled final listing line without a newline is ignored', () => {
  const result = replay([], { readFile: () => JSON.stringify(initial) + '\n{"agent_listing_delta":' });
  assert.equal(result.state, 'known');
  assert.equal(result.records, 1);
  assert.equal(dispatcherPresence(result, 'Explore'), 'present');
  assert.equal(dispatcherPresence(result, 'codex-build'), 'absent');
});

test('a torn final line alone cannot prove any listing', () => {
  assert.equal(replay([], { readFile: () => '{"agent_listing_delta":' }).reason, 'no-listing-record');
});

test('CRLF and a complete final record without a newline are accepted', () => {
  const result = replay([], { readFile: () => [initial, delta].map(entry => JSON.stringify(entry)).join('\r\n') });
  assert.equal(result.state, 'known');
  assert.equal(result.records, 2);
  assert.equal(dispatcherPresence(result, 'codex-build'), 'present');
});
