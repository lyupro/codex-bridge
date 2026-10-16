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
  assert.equal(baseline.meta.status, 'OK');
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
  assert.deepEqual(Buffer.from(first.reply), Buffer.from(baseline.reply));
  assert.equal(first.meta.situation.kind, 'result-present');
  for (const field of ['situation', 'continuation_eligibility', 'treatment']) {
    assert.deepEqual(first.meta[field], second.meta[field]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))[field], first.meta[field]);
  }
});

for (const agent of ['codex-advisor', 'codex-build']) {
  test(`Plan_80 A5: collect records repeatable frozen assessments for ${agent}`, () => {
    const stop = {
      version: 1, trigger: 'deadline', stopped_at: '2026-10-15T08:20:00.000Z',
      result_file: { state: 'missing' },
      session: {
        state: 'observed', last_record_at: '2026-10-15T08:21:00.000Z',
        sampled_at: '2026-10-15T08:22:00.000Z',
        at_reference: {
          last_record_at: '2026-10-15T08:00:00.000Z',
          commands: { state: 'none', reason: null, pending: [] },
        },
      },
    };
    const dir = makeRun({
      status: { stop }, events: [{ type: 'thread.started', thread_id: 'frozen-thread' }],
    });
    // Plan_80 E12: collection must use this saved policy, not the registry threshold.
    fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({
      phase: agent === 'codex-advisor' ? 'advise' : 'default',
      silence_policy: { version: 1, threshold_ms: 1200000 },
    }));
    const first = collect(dir, agent, 1);
    const persistedFirst = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const second = collect(dir, agent, 1);
    const persistedSecond = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    assert.equal(first.meta.status, 'FAIL');
    assert.equal(second.meta.status, first.meta.status);
    assert.equal(second.meta.reason, first.meta.reason);
    assert.equal(second.reply, first.reply);
    assert.deepEqual(first.meta.situation, {
      version: 1, kind: 'silent-stall-candidate', cause: 'deadline',
      silence_ms: 1200000, silence_reason: null, threshold_ms: 1200000,
      commands: { state: 'none', reason: null, pending_count: 0 },
      session_state: 'observed', result_file_state: 'missing',
    });
    const writer = agent === 'codex-build' ? ['writer-role-not-approved'] : [];
    assert.deepEqual(first.meta.continuation_eligibility, {
      version: 2,
      automatic: { allowed: false, blocking_reasons: [
        'recovery-not-enabled', 'resume-contract-unverified', ...writer, 'process-tree-stop-unverified',
      ] },
      grant: { allowed: false, policy_version: 1, blocking_reasons: [
        'resume-grant-not-implemented',
        ...writer, 'process-tree-stop-unverified',
      ] },
    });
    assert.deepEqual(first.meta.treatment, { version: 1, effect: 'diagnostic-only', action: 'retain-stop-facts' });
    for (const field of ['situation', 'continuation_eligibility', 'treatment']) {
      assert.deepEqual(first.meta[field], second.meta[field]);
      assert.deepEqual(persistedFirst[field], first.meta[field]);
      assert.deepEqual(persistedSecond[field], first.meta[field]);
    }
  });
}
