import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import { die, RunnerUsageError } from '../../src/home/lib/runner/args.mjs';
import { codexAvailabilityRefusal } from '../../src/home/lib/runner/preflight.mjs';

const quotaRow = 'The run folder was not created; quota was not spent.';

test('available Codex does not refuse', async () => {
  const refusal = await codexAvailabilityRefusal({ probe: async () => ({ state: 'available' }) });
  assert.equal(refusal, null);
});

// Plan_78 D5: only completed evidence of sign-out may tell the dispatcher not to retry.
for (const state of ['logged-out']) {
  test(`${state} Codex returns the shared UNAVAILABLE rows without spending quota`, async () => {
    const detail = 'codex login status: Not logged in';
    const refusal = await codexAvailabilityRefusal({ probe: async () => ({ state, detail }) });
    assert.equal(refusal.unavailable, true);
    assert.equal(refusal.action, 'unavailable');
    const rows = refusal.text.split('\n');
    assert.equal(rows.length, 5);
    assert.ok(rows[0].startsWith('UNAVAILABLE — '));
    assert.equal(rows[1], `Signal: ${detail}`);
    assert.equal(rows[2], orderDiagnosticMessage('next-action', { variant: 'unavailable' }));
    assert.equal(rows[3], 'Operator check: codex --version; codex login status (sign in with codex login)');
    assert.equal(rows.at(-1), quotaRow);
  });
}

test('a PATH miss keeps the bridge eligible with the exact recovery and quota rows', async () => {
  const detail = 'codex could not be resolved in this process PATH; readiness is unconfirmed';
  const refusal = await codexAvailabilityRefusal({
    probe: async () => ({ state: 'inconclusive', pathMiss: true, detail }),
  });
  assert.deepEqual(refusal, {
    unavailable: false,
    action: 'readiness-unconfirmed',
    text: [
      `Codex CLI readiness unconfirmed: ${detail}`,
      quotaRow,
    ].join('\n'),
  });
});

test('inconclusive evidence keeps the exact ordinary headline and quota rows', async () => {
  const detail = 'codex login status timed out';
  const refusal = await codexAvailabilityRefusal({
    probe: async () => ({ state: 'inconclusive', detail }),
  });
  assert.deepEqual(refusal, {
    unavailable: false,
    action: 'availability-unconfirmed',
    text: [
      `Codex CLI unavailable: ${detail}`,
      quotaRow,
    ].join('\n'),
  });
});

for (const pathMiss of [true, false]) {
  test(`inconclusive availability action is final and free (PATH miss=${pathMiss})`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const refusal = await codexAvailabilityRefusal({
      probe: async () => ({ state: 'inconclusive', pathMiss, detail: 'probe evidence' }),
    });
    const row = orderDiagnosticMessage('next-action', {
      variant: pathMiss ? 'readiness-unconfirmed' : 'availability-unconfirmed',
    });
    assert.throws(() => die(refusal.text, { action: refusal.action, exit: 1 }), (error) => {
      assert.ok(error instanceof RunnerUsageError);
      assert.equal(error.exitCode, 1);
      const lines = error.message.split('\n');
      assert.deepEqual(lines.filter((line) => line.startsWith('Action: ')), [row]);
      assert.equal(lines.at(-1), row);
      assert.equal(lines.at(-2), quotaRow);
      return true;
    });
  });
}
