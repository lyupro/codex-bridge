/** Verifies canonical dispatcher commands and their fail-closed input boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRunCommand, sameCommand } from '../src/home/lib/dispatcher-command.mjs';

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
    assert.equal(result.command.includes('--scope-new'), false, agentType);
  }
  assert.equal(canonicalRunCommand('codex-build', promptFor('codex-build')).command.includes('--scope-new'), false);
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
  assert.match(canonicalRunCommand('codex-scout', multilineFlag).refusal, /order id.*line break/);
});

test('sameCommand allows outer whitespace and rejects every internal text difference', () => {
  const canonical = canonicalRunCommand('codex-scout', promptFor('codex-scout')).command;
  assert.equal(sameCommand(` \t${canonical}\r\n`, canonical), true);
  assert.equal(sameCommand(canonical.replace('--repo ', '--repo  '), canonical), false);
  assert.equal(sameCommand(canonical.replace('"plan-62-build-20260924"', "'plan-62-build-20260924'"), canonical), false);
  assert.equal(sameCommand(`${canonical} --continue`, canonical), false);
});
