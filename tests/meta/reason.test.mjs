#!/usr/bin/env node
/** Verifies failed-run reasons use model and transport events before stderr diagnostics. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../../src/write-meta.mjs';
import { makeRun } from './test-fixtures.mjs';

const emptyBuild = { summary: '', changes: [], report_markdown: '' };

test('the last model content error wins over stderr policy noise', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    stderr: 'ERROR codex_core::tools::router: rejected: blocked by policy\n',
    events: [
      { type: 'item.completed', item: { type: 'error', message: 'first complaint' } },
      { type: 'item.completed', item: { type: 'error', message: 'actual task complaint' } },
    ],
    result: emptyBuild,
  });

  const { meta } = collect(dir, 'codex-build', 1);

  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason, 'actual task complaint');
});

test('a model content error falls back from message to text', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    stderr: 'ERROR policy noise\n',
    events: [{ type: 'item.completed', item: { type: 'error', text: 'text complaint' } }],
    result: emptyBuild,
  });

  const { meta } = collect(dir, 'codex-build', 1);

  assert.equal(meta.reason, 'text complaint');
});

test('a transport event outranks stderr when no model content error exists', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    stderr: 'ERROR policy noise\n',
    events: [{ type: 'error', message: 'transport complaint' }],
    result: emptyBuild,
  });

  const { meta } = collect(dir, 'codex-build', 1);

  assert.equal(meta.reason, 'transport complaint');
});

test('a transport failure keeps its own reason over an older model complaint', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    stderr: 'ERROR policy noise\n',
    events: [
      { type: 'item.completed', item: { type: 'error', message: 'a tool call the model disliked' } },
      { type: 'turn.failed', error: { message: '{"status":429,"error":{"type":"rate_limit_error"}}' } },
    ],
    result: emptyBuild,
  });

  const { meta } = collect(dir, 'codex-build', 1);

  assert.equal(meta.status, 'LIMIT');
  assert.match(meta.reason, /rate_limit_error|429/);
});

test('stderr remains the final fallback when events carry no reason', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    stderr: 'panic: worker failed before producing a result\n',
    events: [{ type: 'thread.started', thread_id: 'thread-stderr-only' }],
    result: emptyBuild,
  });

  const { meta } = collect(dir, 'codex-build', 1);

  assert.equal(meta.reason, 'panic: worker failed before producing a result');
});
