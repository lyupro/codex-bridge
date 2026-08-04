/** Verifies the shared dispatcher input contract and its placeholder detection. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_INPUTS,
  missingInputs,
  renderRequiredInputs,
} from '../src/required-inputs.mjs';

test('the immutable table lists each dispatcher input', () => {
  assert.equal(Object.isFrozen(REQUIRED_INPUTS), true);
  assert.deepEqual(Object.keys(REQUIRED_INPUTS), ['codex-scout', 'codex-build', 'codex-review']);
  for (const entries of Object.values(REQUIRED_INPUTS)) {
    assert.equal(Object.isFrozen(entries), true);
    for (const entry of entries) assert.equal(Object.isFrozen(entry), true);
  }
  assert.deepEqual(REQUIRED_INPUTS['codex-build'].map((entry) => entry.label), ['order id', 'scope']);
});

test('missingInputs reports every required value for every dispatcher', () => {
  assert.deepEqual(missingInputs('codex-scout', '').map((entry) => entry.label), ['order id']);
  assert.deepEqual(missingInputs('codex-build', '').map((entry) => entry.label), ['order id', 'scope']);
  assert.deepEqual(missingInputs('codex-review', '').map((entry) => entry.label), ['order id']);
});

test('template placeholders are missing even when their labels are present', () => {
  const missing = missingInputs(
    'codex-build',
    'order id: <order id from the orchestrator>\nscope: TODO',
  );
  assert.deepEqual(missing.map((entry) => entry.label), ['order id', 'scope']);
  assert.deepEqual(missingInputs('codex-scout', 'order id: LABEL').map((entry) => entry.label), ['order id']);
});

test('valid values pass and the renderer uses the same entries', () => {
  assert.deepEqual(
    missingInputs('codex-build', 'order id: plan-13-build-20260804\nscope: src/runner/**,tests/runner/**'),
    [],
  );
  // Rendered from the table rather than compared against copied literals: pass 2 writes this
  // text into the agent markdown, and a test that restates the examples would keep passing
  // while the two drifted apart — the exact failure mode this contract exists to remove.
  const rendered = renderRequiredInputs('codex-build');
  for (const entry of REQUIRED_INPUTS['codex-build']) {
    assert.ok(
      rendered.includes(`- ${entry.label}: ${entry.explanation} Example: \`${entry.example}\`.`),
      `${entry.label} must be rendered from its own table entry`,
    );
  }
});
