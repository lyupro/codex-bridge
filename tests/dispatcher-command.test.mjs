// Verifies Plan_63 D9 canonical commands and the OW-054 fail-closed call boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRunCommand, sameCommand } from '../src/home/lib/dispatcher-command.mjs';
import { ALL_ORDER_LABELS, ORDER_AGENTS } from '../src/home/lib/order-schema.mjs';
import { SHELL_UNSAFE_SEQUENCES } from '../src/home/lib/shell-unsafe.mjs';

const taskFile = 'C:/scratch/plan-63-task.md';
const prompt = `task file: ${taskFile}`;

test('each dispatcher produces exactly the agent and task-file command with no other tokens', () => {
  for (const agent of ORDER_AGENTS) {
    assert.deepEqual(canonicalRunCommand(agent, prompt), {
      command: `codex-bridge run --agent ${agent} --task-file "${taskFile}"`,
    });
  }
});

test('the command quotes a path with spaces without accessing the task file', () => {
  for (const agent of ORDER_AGENTS) {
    const value = 'C:/nonexistent scratch/absent task.md';
    assert.deepEqual(canonicalRunCommand(agent, `task file: ${value}`), {
      command: `codex-bridge run --agent ${agent} --task-file "${value}"`,
    });
  }
});

test('every former label is refused for every dispatcher rather than translated to a flag', () => {
  for (const agent of ORDER_AGENTS) {
    for (const label of ALL_ORDER_LABELS) {
      const result = canonicalRunCommand(agent, `${prompt}\n${label}: value`);
      assert.deepEqual(result, {
        refusal: 'Refused: the call text must be only label: value lines: '
          + `line 2: label \`${label}\` moved to the task-file header; the call is only \`task file: <absolute path>\`.`,
      });
    }
  }
});

// OW-054: the command must never manufacture --continue from a caller's grant or placeholder.
test('continue none, retry TODO and simultaneous grants produce refusals without commands', () => {
  for (const agent of ORDER_AGENTS) {
    for (const extra of [
      'continue: none', 'retry: TODO',
      'continue: scope-run — next pass; finish it',
      'retry: failed-run — model at capacity; same pass',
      'continue: none\nretry: TODO',
    ]) {
      const result = canonicalRunCommand(agent, `${prompt}\n${extra}`);
      assert.match(result.refusal, /moved to the task-file header/);
      assert.equal(result.command, undefined);
      assert.equal(result.refusal.includes('--continue'), false);
    }
  }
});

test('hyphenated scope-new and decorated order labels are refused with the header repair', () => {
  for (const extra of ['scope-new: src/', '- **scope:** src/', 'order-id: a1']) {
    const result = canonicalRunCommand('codex-build', `${extra}\n${prompt}`);
    assert.match(result.refusal, /line 1: label .* moved to the task-file header/);
    assert.equal(result.command, undefined);
  }
});

test('prose in an otherwise valid call keeps the existing refusal form', () => {
  assert.deepEqual(canonicalRunCommand('codex-scout', `${prompt}\nPlease inspect the repository.`), {
    refusal: 'Refused: the call text must be only label: value lines: '
      + 'line 2: not a `label: value` line; free text belongs in the task file.',
  });
});

test('duplicate task files are refused with source line numbers', () => {
  assert.deepEqual(canonicalRunCommand('codex-scout', `${prompt}\ntask file: C:/second.md`), {
    refusal: 'Refused: the call text must be only label: value lines: '
      + 'line 2: label `task file` is given twice (line 1 and line 2).',
  });
});

test('parser problems with and without line numbers share the dispatcher refusal', () => {
  assert.deepEqual(canonicalRunCommand('codex-scout', 'Please inspect the repository.'), {
    refusal: 'Refused: the call text must be only label: value lines: '
      + 'line 1: not a `label: value` line; free text belongs in the task file; '
      + 'missing required label `task file`.',
  });
});

test('missing task file is refused for every agent without demanding header labels in the call', () => {
  for (const agent of ORDER_AGENTS) {
    assert.deepEqual(canonicalRunCommand(agent, ''), {
      refusal: 'Refused: the call text must be only label: value lines: missing required label `task file`.',
    });
  }
});

test('unknown and prototype-named agents retain their explicit refusal', () => {
  for (const agent of ['codex-haiku', 'toString', 'constructor', '__proto__', undefined, null, 42]) {
    assert.deepEqual(canonicalRunCommand(agent, prompt), {
      refusal: `Refused: unknown dispatcher agent ${JSON.stringify(agent)}.`,
    });
  }
});

test('non-string prompts retain the missing-text refusal', () => {
  for (const value of [undefined, null, 42, {}]) {
    assert.deepEqual(canonicalRunCommand('codex-scout', value), {
      refusal: 'Refused: prompt text is missing or is not text.',
    });
  }
});

test('misspelled labels, placeholders and relative task paths cannot produce commands', () => {
  for (const [text, reason] of [
    [`task-file: ${taskFile}`, /write the label exactly as `task file:`/],
    ['task file: TODO', /task file.*placeholder/],
    ['task file: task.md', /task file.*absolute/],
    ['task file:', /empty value.*missing required label/],
  ]) {
    const result = canonicalRunCommand('codex-scout', text);
    assert.match(result.refusal, reason);
    assert.equal(result.command, undefined);
  }
});

test('shell sequences, quotes and line breaks in task paths are refused', () => {
  for (const sequence of [...SHELL_UNSAFE_SEQUENCES, '"', '\r']) {
    const result = canonicalRunCommand('codex-scout', `task file: C:/safe${sequence}tail`);
    assert.match(result.refusal, /task file.*contains/);
    assert.equal(result.command, undefined);
  }
  assert.match(canonicalRunCommand('codex-scout', `${prompt}\nsmuggled text`).refusal, /line 2:.*free text/);
});

test('the same prompt deterministically produces the same command', () => {
  assert.deepEqual(canonicalRunCommand('codex-advisor', prompt), canonicalRunCommand('codex-advisor', prompt));
});

test('sameCommand allows outer whitespace and rejects every internal text difference', () => {
  const canonical = canonicalRunCommand('codex-scout', prompt).command;
  assert.equal(sameCommand(` \t${canonical}\r\n`, canonical), true);
  assert.equal(sameCommand(canonical.replace('--task-file ', '--task-file  '), canonical), false);
  assert.equal(sameCommand(canonical.replace(`"${taskFile}"`, `'${taskFile}'`), canonical), false);
  assert.equal(sameCommand(`${canonical} --continue`, canonical), false);
  for (const value of [null, undefined, 42]) {
    assert.equal(sameCommand(value, canonical), false);
    assert.equal(sameCommand(canonical, value), false);
  }
});
