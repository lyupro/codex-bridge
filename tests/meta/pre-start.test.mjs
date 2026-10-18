#!/usr/bin/env node
/** Guards the single definition of a run that never started Codex. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { abortedPreStart, startedRuns } from '../../src/home/lib/write-meta.mjs';
import { automaticChildMarker } from '../../src/home/lib/meta/pre-start.mjs';
import { HEARTBEAT_FILE } from '../../src/home/lib/heartbeat.mjs';
import { makeChainRoot } from './test-fixtures.mjs';

const retroactiveMeta = (overrides = {}) => ({
  exit: null,
  session_id: null,
  events_bytes: 0,
  stderr_bytes: 0,
  tokens_reported: false,
  ...overrides,
});

test('an explicit aborted_pre_start state is excluded from started runs', () => {
  const root = makeChainRoot([{ name: 'pre-start', state: 'aborted_pre_start' }]);

  assert.equal(abortedPreStart(path.join(root, 'pre-start')), true);
  assert.deepEqual(startedRuns(root, ['pre-start']), []);
});

test('the retroactive failed shape from the incident is excluded', () => {
  const root = makeChainRoot([{ name: 'old-refusal', state: 'failed', meta: retroactiveMeta() }]);

  assert.equal(abortedPreStart(path.join(root, 'old-refusal')), true);
  assert.deepEqual(startedRuns(root, ['old-refusal']), []);
});

test('a non-empty session id remains a started run and needs continuation permission', () => {
  const root = makeChainRoot([
    {
      name: 'paid-run',
      state: 'failed',
      meta: retroactiveMeta({ session_id: 'thread-123' }),
    },
  ]);

  assert.equal(abortedPreStart(path.join(root, 'paid-run')), false);
  assert.deepEqual(startedRuns(root, ['paid-run']), ['paid-run']);
});

test('retention deleting events.jsonl does not turn a paid run into pre-start', () => {
  // What retention leaves behind: no events.jsonl on disk, while meta still records its byte count.
  // The fixture writes none for this run, so the state is already the one under test — a write
  // followed by a removal said the same thing and only looked like a step that mattered.
  const root = makeChainRoot([
    {
      name: 'retained-paid-run',
      state: 'failed',
      meta: retroactiveMeta({ session_id: 'thread-456', events_bytes: 128 }),
    },
  ]);

  assert.equal(abortedPreStart(path.join(root, 'retained-paid-run')), false);
  assert.deepEqual(startedRuns(root, ['retained-paid-run']), ['retained-paid-run']);
});

test('a reported token count keeps a failed run in the started view', () => {
  const root = makeChainRoot([
    {
      name: 'tokenized-run',
      state: 'failed',
      meta: retroactiveMeta({ tokens_reported: true }),
    },
  ]);

  assert.equal(abortedPreStart(path.join(root, 'tokenized-run')), false);
});

test('startedRuns preserves the chain order while removing only pre-start folders', () => {
  const root = makeChainRoot([
    { name: 'a-pre-start', state: 'aborted_pre_start' },
    { name: 'b-retroactive', state: 'failed', meta: retroactiveMeta() },
    { name: 'c-started', state: 'finished', meta: retroactiveMeta({ session_id: 'thread-789' }) },
  ]);

  assert.deepEqual(startedRuns(root, ['a-pre-start', 'b-retroactive', 'c-started']), ['c-started']);
});

const automaticStatus = () => ({
  state: 'abandoned',
  resumed_from: 'parent',
  recovery: { automatic: true, attempt: 2, parent: 'parent' },
});

test('Plan_80 E18 excludes a never-started abandoned automatic child without a parent pointer', () => {
  const root = makeChainRoot([{ name: 'child', meta: retroactiveMeta() }]);
  const dir = path.join(root, 'child');
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(automaticStatus()));
  assert.equal(abortedPreStart(dir), true);
  assert.deepEqual(startedRuns(root, ['child']), []);
});

for (const [label, options] of [
  ['an empty events file', { evidence: 'events.jsonl' }],
  ['a heartbeat', { evidence: HEARTBEAT_FILE }],
  ['recorded stderr', { meta: { stderr_bytes: 12 } }],
  ['retained event bytes without the transport file', { meta: { events_bytes: 40 } }],
  ['a session id', { meta: { session_id: 'thread-started' } }],
  ['an ordinary abandoned run', { status: { state: 'abandoned' } }],
  ['a mismatched resumed_from', { status: { ...automaticStatus(), resumed_from: 'other' } }],
  ['missing meta.json', { missingMeta: true }],
  ['unreadable meta.json', { malformedMeta: true }],
  ['a non-null exit', { meta: { exit: 0 } }],
  ['reported tokens', { meta: { tokens_reported: true } }],
]) {
  test(`an abandoned automatic child with ${label} remains a started run`, () => {
    const root = makeChainRoot([{ name: 'child',
      ...(options.missingMeta ? {} : { meta: retroactiveMeta(options.meta) }),
    }]);
    const dir = path.join(root, 'child');
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(options.status ?? automaticStatus()));
    if (options.evidence) fs.writeFileSync(path.join(dir, options.evidence), '');
    if (options.malformedMeta) fs.writeFileSync(path.join(dir, 'meta.json'), '{');
    assert.equal(abortedPreStart(dir), false);
    assert.deepEqual(startedRuns(root, ['child']), ['child']);
  });
}

test('the first two pre-start branches retain priority over automatic-child evidence', () => {
  const root = makeChainRoot([
    { name: 'explicit', state: 'aborted_pre_start' },
    { name: 'failed', state: 'failed', meta: retroactiveMeta() },
  ]);
  for (const name of ['explicit', 'failed']) {
    const dir = path.join(root, name);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
    fs.writeFileSync(path.join(dir, HEARTBEAT_FILE), '');
    assert.equal(abortedPreStart(dir), true);
  }
});

test('automaticChildMarker accepts only the exact automatic continuation marker', () => {
  assert.equal(automaticChildMarker(automaticStatus()), true);
  const nullPrototype = { ...automaticStatus(), recovery: Object.assign(Object.create(null),
    automaticStatus().recovery) };
  assert.equal(automaticChildMarker(nullPrototype), true);
  for (const value of [null, undefined, false, 1, 'status', [], {}]) {
    assert.equal(automaticChildMarker(value), false);
  }
  for (const recovery of [null, [], 'recovery', new Date(),
    Object.assign(Object.create({ inherited: true }), automaticStatus().recovery)]) {
    assert.equal(automaticChildMarker({ ...automaticStatus(), recovery }), false);
  }
  for (const patch of [{ automatic: false }, { automatic: 1 }, { attempt: 1 }, { attempt: '2' },
    { parent: '' }, { parent: null }, { parent: 3 }, { parent: '.' }, { parent: '..' },
    { parent: 'a/b' }, { parent: 'a\\b' }]) {
    const recovery = { ...automaticStatus().recovery, ...patch };
    assert.equal(automaticChildMarker({ resumed_from: recovery.parent, recovery }), false);
  }
  assert.equal(automaticChildMarker({ ...automaticStatus(), resumed_from: 'other' }), false);
});
