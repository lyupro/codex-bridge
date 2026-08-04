/** Verifies the shared dispatcher input contract and its placeholder detection. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { replacePlaceholders } from '../cli/manifest.mjs';
import { AGENTS } from '../src/write-meta.mjs';
import {
  REQUIRED_INPUTS,
  missingInputs,
  renderRequiredInputSummary,
  renderRequiredInputs,
} from '../src/required-inputs.mjs';

/**
 * The runner's refusals read their example and source straight out of this table
 * (`requiredInput()` in runner/args.mjs) and use the result without checking it. An agent the
 * runner knows but the table does not would therefore crash on a missing property instead of
 * printing the refusal it was about to print — a refusal path that fails is worse than no
 * refusal, because it hides which input was missing.
 */
test('every agent the runner accepts has an entry in the table', () => {
  assert.deepEqual(Object.keys(AGENTS).sort(), Object.keys(REQUIRED_INPUTS).sort());
});

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

test('expanded dispatcher prompts tell the caller exactly what the gate accepts', async () => {
  for (const [agentType, entries] of Object.entries(REQUIRED_INPUTS)) {
    const source = await fs.readFile(path.join('src', 'agents', `${agentType}.md`), 'utf8');
    const rendered = replacePlaceholders(source, path.resolve('installed', 'agents'));
    const frontmatter = rendered.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    assert.ok(frontmatter, `${agentType} must have frontmatter after placeholder expansion`);
    assert.ok(
      frontmatter.includes(renderRequiredInputSummary(agentType)),
      `${agentType} frontmatter must carry its generated input summary`,
    );
    assert.ok(
      rendered.includes(renderRequiredInputs(agentType)),
      `${agentType} body must carry every generated input entry`,
    );
    assert.doesNotMatch(rendered, /\{\{CODEX_REQUIRED_INPUTS(?:_SUMMARY)?\}\}/);

    const acceptedTask = entries.map((entry) => `${entry.label}: ${entry.example}`).join('\n');
    assert.deepEqual(
      missingInputs(agentType, acceptedTask),
      [],
      `${agentType} gate must accept the values its generated prompt tells the caller to write`,
    );
    for (const entry of entries) {
      assert.ok(
        rendered.includes(`- ${entry.label}: ${entry.explanation} Example: \`${entry.example}\`.`),
        `${agentType} must render the gate input ${entry.label}`,
      );
    }
  }
});
