#!/usr/bin/env node
/** Guards the single definition of a run that never started Codex. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { abortedPreStart, startedRuns } from '../../src/home/lib/write-meta.mjs';
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
