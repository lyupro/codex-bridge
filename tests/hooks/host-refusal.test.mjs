/** Locks the three-part host-refusal recognition contract from the 2026-08-16 probe. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeHostRefusal } from '../../src/home/lib/host-refusal.mjs';

test('recognises a complete host refusal and reports no missing parts', () => {
  const result = recognizeHostRefusal(
    'FAIL — order id `probe-20260816` was refused. Run `codex-bridge install`.',
  );
  assert.deepEqual(result, {
    recognized: true,
    declaresFailure: true,
    namesOrderId: true,
    namesInstallRemedy: true,
    missing: [],
  });
});

test('reports each missing host-refusal part', () => {
  assert.deepEqual(recognizeHostRefusal('Permission denied.'), {
    recognized: false,
    declaresFailure: false,
    namesOrderId: false,
    namesInstallRemedy: false,
    missing: ['FAIL declaration', 'order id', 'codex-bridge install remedy'],
  });
});
