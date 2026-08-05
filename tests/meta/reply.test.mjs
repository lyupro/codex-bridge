#!/usr/bin/env node
/** Verifies replies point operators at the structured read command and name both artifacts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../../src/write-meta.mjs';
import { buildResult, makeRun } from './test-fixtures.mjs';

test('successful replies use the read command instead of a raw file path', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [{ type: 'thread.started', thread_id: 'reply-1' }],
    result: { answer: 'done', findings: [], unknowns: [], report_markdown: '# report' },
  });

  const { reply } = collect(dir, 'codex-scout', 0);

  assert.ok(reply.includes(`Log: codex-bridge read ${dir}`));
  assert.doesNotMatch(reply, /raw\.log/);
});

test('failed replies report events and stderr sizes plus the read command', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [],
    stderr: 'panic: failed before result\n',
    result: buildResult([], { summary: '' }),
  });

  const { reply } = collect(dir, 'codex-build', 1);

  assert.match(reply, /Artifacts: events\.jsonl \d+ B · stderr\.log \d+ B/);
  assert.ok(reply.includes(`Log: codex-bridge read ${dir}`));
  assert.doesNotMatch(reply, /raw\.log|log_bytes/);
});
