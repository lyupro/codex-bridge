#!/usr/bin/env node
/**
 * Guards the write-meta.mjs facade on its stop-record axis: collect() carries the runner's
 * `status.json#stop` into `meta.json` verbatim and never recomputes it.
 *
 * Plan_80 A4 (`dual-evidence`): the stop cause and result-file observation are taken once by the
 * worker, right after Codex stops. A collect() that rebuilt them later would read a different
 * tree, and a recollection after retention would replace the historical record with today's
 * unknowns. An older run without the field gets `null` — not observed, never "false".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect, writeStatus } from '../src/home/lib/write-meta.mjs';
import { buildResult as build, makeRun } from './meta/test-fixtures.mjs';

test('Plan_80 A4: collect preserves stop verbatim across collections without changing the reply', () => {
  const dir = makeRun({ result: build([]), before: '', after: '' });
  const baseline = collect(dir, 'codex-build', 0);
  assert.equal(baseline.meta.stop, null);
  const stop = { version: 1, trigger: 'deadline', stopped_at: '2026-10-15T08:00:00.000Z', exit_code: 1,
    signal: null, process_error: null, stdio_drained: false, elapsed_ms: 1000,
    receipts: { lines: 0, last_received_at: null, incomplete: false, truncated: false, write_error: null }, result_file: { state: 'missing' } };
  writeStatus(dir, { stop });
  const first = collect(dir, 'codex-build', 0), second = collect(dir, 'codex-build', 0);
  assert.deepEqual(first.meta.stop, stop);
  assert.deepEqual(second.meta.stop, stop);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).stop, stop);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')).stop, stop);
  assert.equal(first.reply, baseline.reply);
  assert.equal(second.reply, baseline.reply);
});
