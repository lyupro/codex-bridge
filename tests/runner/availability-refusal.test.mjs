import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexAvailabilityRefusal } from '../../src/home/lib/runner/preflight.mjs';

const quotaRow = 'The run folder was not created; quota was not spent.';

test('available Codex does not refuse', async () => {
  const refusal = await codexAvailabilityRefusal({ probe: async () => ({ state: 'available' }) });
  assert.equal(refusal, null);
});

// Plan_60 D2: only completed evidence of absence or sign-out may tell the dispatcher not to retry.
for (const state of ['missing', 'logged-out']) {
  test(`${state} Codex returns the shared UNAVAILABLE rows without spending quota`, async () => {
    const detail = state === 'missing' ? 'codex is not on PATH' : 'codex login status: Not logged in';
    const refusal = await codexAvailabilityRefusal({ probe: async () => ({ state, detail }) });
    assert.equal(refusal.unavailable, true);
    const rows = refusal.text.split('\n');
    assert.equal(rows.length, 4);
    assert.ok(rows[0].startsWith('UNAVAILABLE — '));
    assert.equal(rows[1], `Signal: ${detail}`);
    assert.equal(rows[2], 'Operator check: codex --version; codex login status (sign in with codex login)');
    assert.equal(rows.at(-1), quotaRow);
  });
}

test('inconclusive evidence keeps the exact ordinary three-row refusal', async () => {
  const detail = 'codex login status timed out';
  const refusal = await codexAvailabilityRefusal({
    probe: async () => ({ state: 'inconclusive', detail }),
  });
  assert.deepEqual(refusal, {
    unavailable: false,
    text: [
      `Codex CLI unavailable: ${detail}`,
      'Operator check: codex --version (and codex login if authorization is rejected)',
      quotaRow,
    ].join('\n'),
  });
});
