/** Verifies the shared dispatcher input contract and its placeholder detection. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { replacePlaceholders } from '../cli/manifest.mjs';
import { AGENTS } from '../src/home/lib/write-meta.mjs';
import { renderNoSelfExecution } from '../src/home/lib/no-self-execution.mjs';
import { renderStopSummary } from '../src/home/lib/stop-contract.mjs';
import {
  CONTINUATION_INPUT,
  REQUIRED_INPUTS,
  diagnoseInput,
  missingInputs,
  parseContinuationGrant,
  renderRequiredInputSummary,
  renderRequiredInputs,
} from '../src/home/lib/required-inputs.mjs';

const agentDirectory = path.join('src', 'agents');

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
  assert.deepEqual(REQUIRED_INPUTS['codex-build'].map((entry) => entry.label), ['order id', 'scope', 'task file', 'continue']);
});

test('missingInputs reports every required value for every dispatcher', () => {
  assert.deepEqual(missingInputs('codex-scout', '').map((entry) => entry.label), ['order id', 'task file']);
  assert.deepEqual(missingInputs('codex-build', '').map((entry) => entry.label), ['order id', 'scope', 'task file']);
  assert.deepEqual(missingInputs('codex-review', '').map((entry) => entry.label), ['order id', 'task file']);
});

test('template placeholders are missing even when their labels are present', () => {
  const missing = missingInputs(
    'codex-build',
    'order id: <order id from the orchestrator>\nscope: TODO',
  );
  assert.deepEqual(missing.map((entry) => entry.label), ['order id', 'scope', 'task file']);
  assert.deepEqual(missingInputs('codex-scout', 'order id: LABEL').map((entry) => entry.label), ['order id', 'task file']);
});

test('diagnosis explains a candidate with a parenthesised qualifier', () => {
  assert.deepEqual(
    diagnoseInput('scope (you may create/modify ONLY these):', 'scope'),
    {
      line: 'scope (you may create/modify ONLY these):',
      reason: 'expected `scope:` with nothing between the label and the colon',
    },
  );
});

test('diagnosis names a placeholder candidate', () => {
  assert.deepEqual(diagnoseInput('scope: TODO', 'scope'), {
    line: 'scope: TODO',
    reason: 'value `TODO` is a placeholder; replace it with a concrete value',
  });
});

test('diagnosis stays empty when the label has no candidate line', () => {
  assert.equal(diagnoseInput('the scope is described in the next section', 'scope'), null);
});

test('diagnosis reports the first candidate line', () => {
  assert.deepEqual(
    diagnoseInput('scope (first qualifier):\nscope (second qualifier):', 'scope'),
    {
      line: 'scope (first qualifier):',
      reason: 'expected `scope:` with nothing between the label and the colon',
    },
  );
});

test('conditional continuation entries stay out of the order-gate input contract', () => {
  for (const [agentType, entries] of Object.entries(REQUIRED_INPUTS)) {
    const unconditional = entries.filter((entry) => !entry.conditional);
    const conditional = entries.filter((entry) => entry.conditional);
    assert.deepEqual(conditional, [CONTINUATION_INPUT]);
    assert.deepEqual(missingInputs(agentType, '').map((entry) => entry.label), unconditional.map((entry) => entry.label));
    assert.deepEqual(
      missingInputs(agentType, `continue: ${CONTINUATION_INPUT.example}`).map((entry) => entry.label),
      unconditional.map((entry) => entry.label),
    );
  }
});

test('continuation grants parse with the accepted separators', () => {
  const run = '2026-08-05_092913_plan14-build';
  const reason = 'LIMIT at step 3, tests unwritten';
  for (const separator of [' — ', ' - ', ': ']) {
    assert.deepEqual(parseContinuationGrant(`continue: ${run}${separator}${reason}`), { run, reason });
  }
});

test('continuation grants reject placeholders and incomplete values', () => {
  const run = '2026-08-05_092913_plan14-build';
  const invalid = [
    '',
    'continue: TODO',
    'continue: <run> — reason',
    `continue: ${run} — TODO`,
    `continue: ${run}`,
    `continue: ${run} — <reason>`,
    `continue: ${run} —`,
  ];
  for (const taskText of invalid) assert.equal(parseContinuationGrant(taskText), null, taskText);
});

test('valid values pass and the renderer uses the same entries', () => {
  assert.deepEqual(
    missingInputs(
      'codex-build',
      'order id: plan-13-build-20260804\nscope: src/home/lib/runner/**,tests/runner/**\n'
        + 'task file: C:/Users/me/AppData/Local/Temp/claude/s/scratchpad/task-plan-13.md',
    ),
    [],
  );
  // Rendered from the table rather than compared against copied literals: pass 2 writes this
  // text into the agent markdown, and a test that restates the examples would keep passing
  // while the two drifted apart — the exact failure mode this contract exists to remove.
  const rendered = renderRequiredInputs('codex-build');
  assert.match(rendered, /Condition: when --continue is passed\./);
  for (const entry of REQUIRED_INPUTS['codex-build']) {
    assert.ok(
      rendered.includes(`- ${entry.label}: ${entry.explanation} Example: \`${entry.example}\`.`),
      `${entry.label} must be rendered from its own table entry`,
    );
  }
});

test('every dispatcher markdown file carries the shared no-self-execution placeholder first', async () => {
  const files = (await fs.readdir(agentDirectory)).filter((file) => file.endsWith('.md')).sort();
  assert.deepEqual(files, Object.keys(AGENTS).map((agentType) => `${agentType}.md`).sort());
  for (const file of files) {
    const source = await fs.readFile(path.join(agentDirectory, file), 'utf8');
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trimStart();
    assert.match(body, /^\{\{CODEX_NO_SELF_EXECUTION\}\}/, `${file} must put the shared block first`);
  }
});

test('placeholder expansion renders the complete no-self-execution prohibition', async () => {
  for (const agentType of Object.keys(AGENTS)) {
    const source = await fs.readFile(path.join(agentDirectory, `${agentType}.md`), 'utf8');
    const rendered = replacePlaceholders(source, path.resolve('installed', 'agents'));
    assert.ok(rendered.includes(renderNoSelfExecution()), `${agentType} must render the prohibition`);
    assert.doesNotMatch(rendered, /\{\{CODEX_NO_SELF_EXECUTION\}\}/);
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
    assert.ok(frontmatter.includes(renderStopSummary()), `${agentType} frontmatter must carry stop guidance`);
    assert.doesNotMatch(rendered, /\{\{CODEX_STOP_SUMMARY\}\}/);

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
