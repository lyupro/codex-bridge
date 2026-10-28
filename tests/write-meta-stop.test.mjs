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
import { stopRows } from '../src/home/lib/meta/stop-rows.mjs';
import { buildResult as build, makeRun } from './meta/test-fixtures.mjs';

test('OW-078 B2: the measured output-limit failure blocks resume without changing FAIL or exit', () => {
  const events = fs.readFileSync(new URL('./meta/fixtures/codex-0.164-output-limit.events.jsonl', import.meta.url), 'utf8');
  const stop = {
    version: 2, trigger: 'exit', stopped_at: '2026-10-28T12:00:00.000Z', exit_code: 1,
    tree_stop: { state: 'exited' }, result_file: { state: 'missing' },
    session: { state: 'observed', at_reference: {
      last_record_at: '2026-10-28T11:40:00.000Z',
      commands: { state: 'none', reason: null, pending: [] },
    } },
  };
  const dir = makeRun({ events, status: { stop, order_id: 'ow078-b2', phase: 'advise' } });
  fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({
    phase: 'advise', silence_policy: { threshold_ms: 996000 },
    recovery_policy: { enabled: true, brake: { value: 'on' }, budget_ms: 1102000 },
  }));
  const { meta, reply } = collect(dir, 'codex-advisor', 1);
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.exit, 1);
  assert.equal(meta.result_ok, false);
  assert.deepEqual(meta.stop, stop);
  assert.equal(meta.situation.kind, 'output-limit');
  assert.deepEqual(meta.treatment, { version: 1, effect: 'diagnostic-only', action: 'narrow-order-or-lower-effort' });
  assert.deepEqual(meta.continuation_eligibility.grant, {
    allowed: false, policy_version: 2, blocking_reasons: ['codex-turn-failed'],
  });
  assert.deepEqual(meta.continuation_eligibility.automatic, {
    allowed: false, blocking_reasons: ['codex-turn-failed', 'not-silent-stall'],
  });
  assert.equal(stopRows(meta, dir).some((row) => row.startsWith('Ready resume line:')), false);
  assert.equal(reply.includes('Ready resume line:'), false);
  const second = collect(dir, 'codex-advisor', 1);
  assert.deepEqual(second.meta.continuation_eligibility, meta.continuation_eligibility);
  assert.equal(second.reply, reply);
});

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
      version: 3,
      automatic: { allowed: false, blocking_reasons: [
        'recovery-policy-missing', ...writer, 'process-tree-stop-unverified',
      ] },
      grant: { allowed: false, policy_version: 2, blocking_reasons: [
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

test('collect assesses the frozen policy and denies a second automatic recovery attempt', () => {
  const stop = {
    version: 2, trigger: 'deadline', stopped_at: '2026-10-15T08:20:00.000Z',
    tree_stop: { state: 'stopped' }, result_file: { state: 'missing' },
    session: { state: 'observed', at_reference: {
      last_record_at: '2026-10-15T08:00:00.000Z',
      commands: { state: 'none', reason: null, pending: [] },
    } },
  };
  const recoveryPolicy = { enabled: true, brake: { value: 'on' }, budget_ms: 1102000 };
  for (const resumedFrom of [null, 'stalled-pass']) {
    const dir = makeRun({ status: { stop, resumed_from: resumedFrom },
      events: [{ type: 'thread.started', thread_id: 'frozen-thread' }] });
    fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({
      phase: 'advise', silence_policy: { threshold_ms: 996000 }, recovery_policy: recoveryPolicy,
    }));
    const first = collect(dir, 'codex-advisor', 1);
    const second = collect(dir, 'codex-advisor', 1);
    assert.equal(first.meta.status, 'FAIL');
    assert.equal(first.meta.situation.kind, 'silent-stall-candidate');
    assert.equal(first.meta.situation.cause, 'deadline');
    assert.deepEqual(first.meta.recovery_policy, recoveryPolicy);
    assert.equal(first.meta.resumed_from, resumedFrom);
    assert.deepEqual(first.meta.continuation_eligibility, {
      version: 3,
      automatic: { allowed: resumedFrom === null, blocking_reasons: resumedFrom ? ['recovery-attempt-spent'] : [] },
      grant: { allowed: true, policy_version: 2, blocking_reasons: [] },
    });
    assert.deepEqual(second.meta.continuation_eligibility, first.meta.continuation_eligibility);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).continuation_eligibility,
      first.meta.continuation_eligibility);
    assert.equal(second.reply, first.reply);
    assert.equal(first.reply.split('\n').find((row) => row.startsWith('Continuation:')), resumedFrom
      ? 'Continuation: automatic blocked (recovery-attempt-spent) · grant allowed'
      : 'Continuation: automatic allowed · grant allowed');
  }
});
