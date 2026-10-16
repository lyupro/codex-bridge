/** Plan_80 E13/O8: registered read-only resume grants must not retain an implementation blocker. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORDER_AGENTS, orderLabelsFor } from '../../src/home/lib/order-schema.mjs';
import { AGENTS } from '../../src/home/lib/agents.mjs';
import { assessStop } from '../../src/home/lib/meta/stop-assessment.mjs';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { makeRun } from './test-fixtures.mjs';

const stopFacts = () => ({
  version: 2, trigger: 'deadline', stopped_at: '2026-10-15T08:20:00.000Z',
  tree_stop: { state: 'stopped' },
  result_file: { state: 'missing' },
  session: {
    state: 'observed',
    at_reference: {
      last_record_at: '2026-10-15T08:00:00.000Z',
      commands: { state: 'none', reason: null, pending: [] },
    },
  },
});

const input = (agent) => ({
  status: 'FAIL', resultOk: false, agentWrites: AGENTS[agent].writes, threadId: 'resume-thread',
  stop: stopFacts(), silencePolicy: { threshold_ms: 1200000 },
});

test('every resume-enabled registry role rejects the retired implementation blocker for all fact combinations', () => {
  const agents = ORDER_AGENTS.filter((agent) => orderLabelsFor(agent).some(({ label }) => label === 'resume'));
  assert.deepEqual(agents, ['codex-scout', 'codex-review', 'codex-advisor']);
  for (const agent of agents) {
    assert.equal(AGENTS[agent].writes, false);
    for (const status of ['OK', 'FAIL', 'LIMIT', 'UNAVAILABLE']) {
      for (const resultOk of [false, true]) {
        for (const threadId of [null, 'resume-thread']) {
          for (const trigger of ['deadline', 'exit', 'spawn-error', 'stream-error', null]) {
            for (const state of ['observed', 'missing', 'unreadable', 'empty', 'unrecognized', 'incomplete', undefined]) {
              for (const tree of ['stopped', 'exited', 'unverified', undefined]) {
                const args = { ...input(agent), status, resultOk, threadId };
                Object.assign(args.stop, { trigger, tree_stop: { state: tree } });
                args.stop.session.state = state;
                const grant = assessStop(args).continuation_eligibility.grant;
                assert.equal(grant.blocking_reasons.includes('resume-grant-not-implemented'), false, agent);
                assert.equal(grant.allowed, grant.blocking_reasons.length === 0);
              }
            }
          }
        }
      }
    }
    for (const stop of [null, undefined, {}]) {
      const grant = assessStop({ ...input(agent), stop }).continuation_eligibility.grant;
      assert.equal(grant.blocking_reasons.includes('resume-grant-not-implemented'), false, agent);
    }
  }
});

test('no runtime library module contains the retired implementation blocker', () => {
  function checkDirectory(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) checkDirectory(file);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) {
        assert.equal(fs.readFileSync(file, 'utf8').includes('resume-grant-not-implemented'), false, file);
      }
    }
  }
  checkDirectory(fileURLToPath(new URL('../../src/home/lib/', import.meta.url)));
});

function failedRun(agent) {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [{ type: 'thread.started', thread_id: 'resume-thread' }],
    status: { phase: agent === 'codex-advisor' ? 'advise' : 'default', order_id: 'ow066-o8', stop: stopFacts() },
  });
  fs.writeFileSync(path.join(dir, 'worker.json'), `${JSON.stringify({
    phase: agent === 'codex-advisor' ? 'advise' : 'default',
    silence_policy: { version: 1, threshold_ms: 1200000 },
  })}\n`, 'utf8');
  return dir;
}

test('an eligible failed advisor advise run records an allowed grant and prints the ready resume line', () => {
  const dir = failedRun('codex-advisor');
  const { meta, reply } = collect(dir, 'codex-advisor', 1);
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.phase, 'advise');
  assert.equal(meta.result_ok, false);
  assert.equal(meta.session_id, 'resume-thread');
  assert.deepEqual(meta.continuation_eligibility, {
    version: 2,
    automatic: { allowed: false, blocking_reasons: ['recovery-not-enabled', 'resume-contract-unverified'] },
    grant: { allowed: true, policy_version: 1, blocking_reasons: [] },
  });
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.deepEqual(persisted.continuation_eligibility, meta.continuation_eligibility);
  const rows = reply.split('\n');
  const at = rows.findIndex((row) => row.startsWith('Continuation:'));
  assert.ok(at >= 0);
  assert.equal(rows[at], 'Continuation: automatic blocked (recovery-not-enabled, resume-contract-unverified) · grant allowed');
  assert.equal(rows[at + 1],
    `Ready resume line: resume: ${path.basename(dir)} — continue after silent-stall-candidate (continues that pass's Codex thread under order ow066-o8).`);
  assert.equal(rows[at + 2], 'Treatment: retain-stop-facts · diagnostic only, nothing runs it');
  const second = collect(dir, 'codex-advisor', 1);
  assert.deepEqual(second.meta.continuation_eligibility, meta.continuation_eligibility);
  assert.equal(second.reply, reply);
});

test('the same failed run for codex-build retains the writer-role blocker', () => {
  const dir = failedRun('codex-build');
  const { meta, reply } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.result_ok, false);
  assert.deepEqual(meta.continuation_eligibility.grant, {
    allowed: false, policy_version: 1, blocking_reasons: ['writer-role-not-approved'],
  });
  assert.deepEqual(meta.continuation_eligibility.automatic, {
    allowed: false,
    blocking_reasons: ['recovery-not-enabled', 'resume-contract-unverified', 'writer-role-not-approved'],
  });
  assert.equal(reply.includes('Ready resume line:'), false);
});
