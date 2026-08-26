#!/usr/bin/env node
/** Verifies replies point operators at the structured read command and name both artifacts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect } from '../../src/home/lib/write-meta.mjs';
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

test('successful build replies preserve summaries longer than the old 160-character limit', () => {
  const summary = `${'verified behavior '.repeat(11)}final marker`;
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [{ type: 'thread.started', thread_id: 'reply-long-summary' }],
    result: buildResult([], { summary }),
  });

  const { reply } = collect(dir, 'codex-build', 0);

  assert.ok(summary.length > 160 && summary.length < 300);
  assert.ok(reply.includes(summary));
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

/**
 * The row that would have exposed the defect it was written for: for three releases a run answered
 * on a model nobody ordered, and no line of any reply named a model at all.
 */
test('a reply names the ordered worker and where its depth came from', () => {
  const dir = makeRun({
    args: ['exec', '--json', '-m', 'pinned-model'],
    profile: { model: 'pinned-model', model_source: 'config', effort: 'max', effort_source: 'config' },
    events: [{ type: 'thread.started', thread_id: 'reply-profile' }],
    result: buildResult([]),
  });

  const { reply } = collect(dir, 'codex-build', 0);
  const rows = reply.split('\n');

  assert.match(reply, /^Model: pinned-model at max effort \(config\)$/m);
  // Beside the log link rather than at the end: a dispatcher reads the tail of a reply, and the
  // two rows answer the same question — what ran, and where to look it up.
  assert.equal(rows.findIndex((r) => r.startsWith('Model: ')) + 1, rows.findIndex((r) => r.includes('Log: ')));
});

test('a run with no pinned model says so instead of going quiet', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    profile: { model: '', model_source: 'codex default', effort: 'medium', effort_source: 'fallback' },
    events: [{ type: 'thread.started', thread_id: 'reply-default-profile' }],
    result: buildResult([]),
  });

  const { reply } = collect(dir, 'codex-build', 0);

  assert.match(reply, /^Model: codex default at medium effort \(fallback\)$/m);
});

test('an archived run without a profile keeps its reply unchanged', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [{ type: 'thread.started', thread_id: 'reply-archived' }],
    result: buildResult([]),
  });

  const { reply } = collect(dir, 'codex-build', 0);

  assert.doesNotMatch(reply, /^Model:/m);
});
