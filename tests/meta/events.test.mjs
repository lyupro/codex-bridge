#!/usr/bin/env node
/**
 * Guards the structured transport reader: malformed JSONL is disposable, while accounting,
 * session identity, and transport errors remain facts from the CLI event stream.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

test('exposes the last model content error and falls back to item text', () => {
  const dir = makeRun({
    events: [
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'error', message: 'first complaint' } },
      { type: 'item.completed', item: { type: 'error', text: 'last complaint' } },
    ],
  });

  assert.equal(readEvents(dir).content_error, 'last complaint');
});

// codex-cli 0.146.0 reports its own deprecated-config warning as an item error before the turn
// opens. Reading it as the model's complaint made "`[features].codex_hooks` is deprecated" the
// stated reason a run failed — the verdict naming something other than what happened.
test('a CLI error before the turn opens is not the model complaining about the order', () => {
  const dir = makeRun({
    events: [
      { type: 'thread.started', thread_id: 'thread-19' },
      { type: 'item.completed', item: { type: 'error', message: 'config key is deprecated' } },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'working' } },
    ],
  });

  assert.equal(readEvents(dir).content_error, null);
});

test('a run that never opened a turn has no content error to report', () => {
  const dir = makeRun({
    events: [
      { type: 'thread.started', thread_id: 'thread-20' },
      { type: 'item.completed', item: { type: 'error', message: 'config key is deprecated' } },
    ],
  });

  assert.equal(readEvents(dir).content_error, null);
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

test('readEvents distinguishes an empty stream from a missing stream', () => {
  const empty = makeRun({ events: [], stderr: '' });
  const missing = makeRun({ stderr: '' });

  assert.deepEqual(
    { hasStream: readEvents(empty).hasStream, hasEvents: readEvents(empty).hasEvents },
    { hasStream: true, hasEvents: false },
  );
  assert.deepEqual(
    { hasStream: readEvents(missing).hasStream, hasEvents: readEvents(missing).hasEvents },
    { hasStream: false, hasEvents: false },
  );
});

test('meta.json accounts for events.jsonl and stderr.log without log_bytes', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [{ type: 'thread.started', thread_id: 'meta-1' }],
    stderr: 'diagnostic text\n',
    result: buildResult([]),
  });

  collect(dir, 'codex-build', 0);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));

  assert.equal(meta.events_bytes, fs.statSync(path.join(dir, 'events.jsonl')).size);
  assert.equal(meta.stderr_bytes, fs.statSync(path.join(dir, 'stderr.log')).size);
  assert.equal('log_bytes' in meta, false);
  assert.equal(fs.existsSync(path.join(dir, 'raw.log')), false);
});
