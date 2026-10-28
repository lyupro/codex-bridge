/** OW-078: output-ceiling failures explain how to revise the order without offering resume. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import { makeRun } from './test-fixtures.mjs';

const outputLimitEvents = fs.readFileSync(new URL('./fixtures/codex-0.164-output-limit.events.jsonl', import.meta.url), 'utf8');
const unknownFailureEvents = outputLimitEvents.trim().split('\n').map((row) => {
  const event = JSON.parse(row);
  if (event.type === 'error') event.message = 'Unknown turn failure';
  if (event.type === 'turn.failed') event.error.message = 'Unknown turn failure';
  return JSON.stringify(event);
}).join('\n') + '\n';

for (const agent of ['codex-build', 'codex-scout', 'codex-review', 'codex-advisor']) {
  for (const [variant, events] of [
    ['fail-output-limit', outputLimitEvents],
    ['fail-no-result', unknownFailureEvents],
  ]) {
    test(`${agent} collects ${variant} with exactly one Action and no ready resume line`, () => {
      const stop = {
        version: 2, trigger: 'exit', stopped_at: '2026-10-28T12:00:00.000Z', exit_code: 1,
        tree_stop: { state: 'exited' }, result_file: { state: 'missing' },
        session: { state: 'observed', at_reference: {
          last_record_at: '2026-10-28T11:40:00.000Z',
          commands: { state: 'none', reason: null, pending: [] },
        } },
      };
      const phase = agent === 'codex-advisor' ? 'advise' : 'default';
      const dir = makeRun({ events, status: { stop, order_id: 'ow078-b4', phase } });
      fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({
        phase, silence_policy: { threshold_ms: 996000 },
        recovery_policy: { enabled: true, brake: { value: 'on' }, budget_ms: 1102000 },
      }));
      const { meta, reply } = collect(dir, agent, 1);
      assert.equal(meta.status, 'FAIL');
      assert.equal(meta.exit, 1);
      assert.equal(meta.result_ok, false);
      assert.match(reply, /^FAIL /);
      assert.deepEqual(reply.split('\n').filter((row) => row.startsWith('Action:')), [
        orderDiagnosticMessage('next-action', { variant }),
      ]);
      assert.doesNotMatch(reply, /Ready resume line:/);
      if (variant === 'fail-output-limit') {
        assert.equal(meta.situation.kind, 'output-limit');
        assert.deepEqual(meta.treatment, {
          version: 1, effect: 'diagnostic-only', action: 'narrow-order-or-lower-effort',
        });
        assert.match(reply, /narrow-order-or-lower-effort/);
      }
    });
  }
}
