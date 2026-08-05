#!/usr/bin/env node
/**
 * Guards the structured transport reader: malformed JSONL is disposable, while accounting,
 * session identity, and transport errors remain facts from the CLI event stream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEvents } from '../../src/meta/events.mjs';
import { buildResult, makeRun } from './test-fixtures.mjs';
import { collect } from '../../src/write-meta.mjs';

test('sums turn usage, preserves the full usage object, and reads thread id', () => {
  const dir = makeRun({
    events: [
      { type: 'thread.started', thread_id: 'thread-16' },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 3,
          reasoning_output_tokens: 1,
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 20,
          cached_input_tokens: 4,
          output_tokens: 5,
          reasoning_output_tokens: 2,
        },
      },
    ],
  });

  const parsed = readEvents(dir);

  assert.equal(parsed.tokens, 38);
  assert.deepEqual(parsed.usage, {
    input_tokens: 30,
    cached_input_tokens: 6,
    output_tokens: 8,
    reasoning_output_tokens: 3,
  });
  assert.equal(parsed.session_id, 'thread-16');
});

test('a truncated final JSONL line does not hide earlier events', () => {
  const complete = JSON.stringify({ type: 'thread.started', thread_id: 'thread-17' });
  const dir = makeRun({ events: `${complete}\n{"type":"turn.completed","usage":{"input_tokens":` });

  const parsed = readEvents(dir);

  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.session_id, 'thread-17');
  assert.equal(parsed.tokens, null);
  assert.equal(parsed.usage, null);
});

test('model and sandbox come from the runner arguments when events are present', () => {
  const dir = makeRun({
    args: ['exec', '--json', '-m', 'configured-model', '--sandbox', 'read-only'],
    events: [{ type: 'thread.started', thread_id: 'thread-18' }],
    result: buildResult([]),
  });

  const { meta } = collect(dir, 'codex-build', 0);

  assert.equal(meta.model, 'configured-model');
  assert.equal(meta.sandbox, 'read-only');
});
