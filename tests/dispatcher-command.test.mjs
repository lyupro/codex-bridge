/** Verifies canonical dispatcher commands and their fail-closed input boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRunCommand, sameCommand } from '../src/home/lib/dispatcher-command.mjs';
import { REQUIRED_INPUTS } from '../src/home/lib/required-inputs.mjs';

const taskFile = 'C:/scratch/plan-62-task.md';

function promptFor(agentType, extra = {}) {
  const fields = { 'order id': 'plan-62-build-20260924', 'task file': taskFile };
  if (agentType === 'codex-build') fields.scope = 'src/home/lib/**,tests/**';
  if (agentType === 'codex-advisor') fields.phase = 'scope';
  return Object.entries({ ...fields, ...extra }).map(([label, value]) => `${label}: ${value}`).join('\n');
}

test('each dispatcher produces its exact canonical command', () => {
  const cases = [
    ['codex-scout', 'codex-bridge run --agent codex-scout --repo "." --order-id "plan-62-build-20260924" --task-file "C:/scratch/plan-62-task.md"'],
    ['codex-build', 'codex-bridge run --agent codex-build --repo "." --scope "src/home/lib/**,tests/**" --order-id "plan-62-build-20260924" --task-file "C:/scratch/plan-62-task.md"'],
    ['codex-review', 'codex-bridge run --agent codex-review --repo "." --order-id "plan-62-build-20260924" --task-file "C:/scratch/plan-62-task.md"'],
    ['codex-advisor', 'codex-bridge run --agent codex-advisor --repo "." --phase "scope" --order-id "plan-62-build-20260924" --task-file "C:/scratch/plan-62-task.md"'],
  ];
  for (const [agentType, expected] of cases) {
    assert.deepEqual(canonicalRunCommand(agentType, promptFor(agentType)), { command: expected });
  }
});

test('optional values add flags in fixed order and are absent when omitted', () => {
  const prompt = promptFor('codex-build', {
    repository: 'E:/work/repository',
    'scope new': 'src/new/**',
    slug: 'plan-62-run',
    effort: 'high',
  });
  assert.deepEqual(canonicalRunCommand('codex-build', prompt), {
    command: 'codex-bridge run --agent codex-build --repo "E:/work/repository" --scope "src/home/lib/**,tests/**" --scope-new "src/new/**" --slug "plan-62-run" --order-id "plan-62-build-20260924" --task-file "C:/scratch/plan-62-task.md" --effort "high"',
  });
  for (const agentType of ['codex-scout', 'codex-review', 'codex-advisor']) {
    const result = canonicalRunCommand(agentType, `${promptFor(agentType)}\nscope new: src/new/**`);
    assert.match(result.refusal, /scope new.*not accepted/, agentType);
    assert.equal(result.command, undefined, agentType);
  }
  assert.equal(canonicalRunCommand('codex-build', promptFor('codex-build')).command.includes('--scope-new'), false);
});

test('review changesets follow the repo pair before the remaining flags', () => {
  for (const changeset of ['base:main', 'commit:abc123']) {
    const prompt = promptFor('codex-review', { changeset, slug: 'review-run', effort: 'high' });
    assert.deepEqual(canonicalRunCommand('codex-review', prompt), {
      command: `codex-bridge run --agent codex-review --repo "." --changeset "${changeset}"`
        + ' --slug "review-run" --order-id "plan-62-build-20260924"'
        + ' --task-file "C:/scratch/plan-62-task.md" --effort "high"',
    });
  }
});

test('a build call refuses changeset labels', () => {
  const result = canonicalRunCommand('codex-build', promptFor('codex-build', { changeset: 'base:main' }));
  assert.match(result.refusal, /changeset.*not accepted.*codex-build/);
  assert.equal(result.command, undefined);
});

// Plan_76 D1: the live scope-new line above scope must never become --scope "new: src/".
test('a hyphenated scope-new label above scope is refused', () => {
  const prompt = promptFor('codex-build').replace('\nscope:', '\nscope-new: src/\nscope:');
  const result = canonicalRunCommand('codex-build', prompt);
  assert.match(result.refusal, /line 3: write the label exactly as `scope new:`/);
  assert.equal(result.command, undefined);
});

test('prose in an otherwise valid call is refused as free text', () => {
  const result = canonicalRunCommand('codex-scout', `${promptFor('codex-scout')}\nPlease inspect the repository.`);
  assert.match(result.refusal, /^Refused: the call text must be only label: value lines: line 3:.*free text/);
  assert.equal(result.command, undefined);
});

test('duplicate labels are refused with their line numbers', () => {
  const result = canonicalRunCommand('codex-scout', `${promptFor('codex-scout')}\norder id: second-order`);
  assert.equal(result.refusal,
    'Refused: the call text must be only label: value lines: '
      + 'line 3: label `order id` is given twice (line 1 and line 3).');
  assert.equal(result.command, undefined);
});

test('parser problems with and without line numbers share the dispatcher refusal', () => {
  const result = canonicalRunCommand('codex-scout', 'Please inspect the repository.');
  assert.equal(result.refusal,
    'Refused: the call text must be only label: value lines: '
      + 'line 1: not a `label: value` line; free text belongs in the task file; '
      + 'missing required label `order id`; missing required label `task file`.');
  assert.equal(result.command, undefined);
});

test('non-string prompts retain the missing-text refusal', () => {
  for (const prompt of [undefined, null, 42, {}]) {
    assert.deepEqual(canonicalRunCommand('codex-scout', prompt), {
      refusal: 'Refused: prompt text is missing or is not text.',
    });
  }
});

// Plan_62 B1 acceptance: the live 2026-09-24 advise grant carried a semicolon in its reason.
test('a continuation reason with shell punctuation still yields the bare continue flag', () => {
  const prompt = `${promptFor('codex-scout')}\ncontinue: 2026-09-24_093731_plan62 — eight paths and five risks; advise settles them`;
  assert.match(canonicalRunCommand('codex-scout', prompt).command, / --continue$/);
});

test('a valid continuation grant adds one bare continue flag', () => {
  const prompt = `${promptFor('codex-scout')}\ncontinue: 2026-09-24_101500_plan62 — LIMIT after review`;
  assert.equal(
    canonicalRunCommand('codex-scout', prompt).command,
    'codex-bridge run --agent codex-scout --repo "." --order-id "plan-62-build-20260924" --task-file "C:/scratch/plan-62-task.md" --continue',
  );
});

// Plan_75 D1, TradeForge capacity incident: the same failed pass needs the runner's explicit flag.
test('a retry grant adds one bare continue flag for every dispatcher', () => {
  for (const agentType of Object.keys(REQUIRED_INPUTS)) {
    const prompt = promptFor(agentType, { retry: 'failed-run — model at capacity; same pass again' });
    const original = canonicalRunCommand(agentType, promptFor(agentType)).command;
    assert.deepEqual(canonicalRunCommand(agentType, prompt), { command: `${original} --continue` });
  }
});

test('both grants still add one continue flag so the runner can issue its refusal', () => {
  for (const agentType of Object.keys(REQUIRED_INPUTS)) {
    const prompt = promptFor(agentType, {
      continue: 'scope-run — next pass',
      retry: 'failed-run — same pass again',
    });
    const original = canonicalRunCommand(agentType, promptFor(agentType)).command;
    assert.deepEqual(canonicalRunCommand(agentType, prompt), { command: `${original} --continue` });
  }
});

test('no grant leaves the continue flag absent for every dispatcher', () => {
  for (const agentType of Object.keys(REQUIRED_INPUTS)) {
    const result = canonicalRunCommand(agentType, promptFor(agentType));
    assert.equal(result.command.includes('--continue'), false, agentType);
  }
});

test('the same prompt deterministically produces the same command', () => {
  const prompt = promptFor('codex-advisor');
  assert.deepEqual(canonicalRunCommand('codex-advisor', prompt), canonicalRunCommand('codex-advisor', prompt));
});

test('unknown agents, missing or placeholder inputs, and relative task paths are refused by label', () => {
  assert.match(canonicalRunCommand('codex-haiku', '').refusal, /unknown dispatcher agent/);
  assert.match(canonicalRunCommand('codex-scout', `task file: ${taskFile}`).refusal, /order id/);
  assert.match(canonicalRunCommand('codex-scout', promptFor('codex-scout', { 'order id': 'TODO' })).refusal, /order id/);
  assert.match(canonicalRunCommand('codex-scout', promptFor('codex-scout', { 'task file': 'task.md' })).refusal, /task file.*absolute/);
  assert.match(canonicalRunCommand('codex-build', promptFor('codex-build').replace(/\nscope:.*$/, '')).refusal, /scope/);
  assert.match(canonicalRunCommand('codex-advisor', promptFor('codex-advisor').replace(/\nphase:.*$/, '')).refusal, /phase/);
});

test('unsafe shell sequences, quotes, and line breaks in values are refused', () => {
  for (const orderId of ['bad;value', 'bad$(value)', 'bad"value']) {
    assert.match(canonicalRunCommand('codex-scout', promptFor('codex-scout', { 'order id': orderId })).refusal, /order id/);
  }
  const multilineFlag = `--order-id "first line\nsecond line"\ntask file: ${taskFile}`;
  assert.match(canonicalRunCommand('codex-scout', multilineFlag).refusal, /line 1:.*free text/);
});

test('sameCommand allows outer whitespace and rejects every internal text difference', () => {
  const canonical = canonicalRunCommand('codex-scout', promptFor('codex-scout')).command;
  assert.equal(sameCommand(` \t${canonical}\r\n`, canonical), true);
  assert.equal(sameCommand(canonical.replace('--repo ', '--repo  '), canonical), false);
  assert.equal(sameCommand(canonical.replace('"plan-62-build-20260924"', "'plan-62-build-20260924'"), canonical), false);
  assert.equal(sameCommand(`${canonical} --continue`, canonical), false);
});
