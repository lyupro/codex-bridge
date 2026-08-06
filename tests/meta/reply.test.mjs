#!/usr/bin/env node
/** Verifies replies point operators at the structured read command and name both artifacts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

test('replies report retained bytes from status.json, the only place housekeeping is recorded', () => {
  const retention = { bytes_freed: 41.2 * 1024 * 1024, runs: 12, days: 30 };
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [{ type: 'thread.started', thread_id: 'reply-retention' }],
    result: buildResult([]),
    status: { state: 'running', retention },
  });

  const { reply } = collect(dir, 'codex-build', 0);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));

  assert.match(reply, /Retention: freed 41\.2 MB from 12 runs older than 30 days/);
  assert.deepEqual(status.retention, retention);
});

test('replies omit retention when no bytes were freed', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [{ type: 'thread.started', thread_id: 'reply-no-retention' }],
    result: buildResult([]),
    status: { state: 'running', retention: { bytes_freed: 0, runs: 1, days: 30 } },
  });

  const { reply } = collect(dir, 'codex-build', 0);

  assert.doesNotMatch(reply, /^Retention:/m);
});
