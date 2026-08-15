/** Guards dispatcher examples with the same shell-unsafe list enforced by the runtime layers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  firstShellUnsafeSequence,
  SHELL_UNSAFE_SEQUENCES,
} from '../src/home/lib/shell-unsafe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_DIR = path.join(ROOT, 'src', 'agents');
const GATE = path.join(ROOT, 'src', 'home', 'hooks', 'order-gate.mjs');

function commandBlocks(source) {
  return [...source.matchAll(/```(?:bash|sh|shell)\s*\r?\n([\s\S]*?)```/gi)].map((match) => match[1]);
}

function unsafeArguments(source, name) {
  const findings = [];
  for (const block of commandBlocks(source)) {
    for (const match of block.matchAll(/(--[A-Za-z0-9-]+)(?:=|\s+)("[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/g)) {
      const sequence = firstShellUnsafeSequence(match[2]);
      if (sequence !== null) findings.push({ name, flag: match[1], sequence });
    }
  }
  return findings;
}

function payload(prompt) {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'codex-build', prompt },
    tool_use_id: 'toolu-shell-unsafe',
  });
}

function runGate(root, prompt) {
  return spawnSync(process.execPath, [GATE], {
    input: payload(prompt),
    encoding: 'utf8',
    env: { ...process.env, HOME: root, USERPROFILE: root },
  });
}

test('dispatcher command arguments contain no new shell-unsafe sequences', async () => {
  const names = (await fs.readdir(AGENTS_DIR)).filter((name) => name.endsWith('.md')).sort();
  const findings = [];
  for (const name of names) {
    const source = await fs.readFile(path.join(AGENTS_DIR, name), 'utf8');
    findings.push(...unsafeArguments(source, name));
  }
  // Step 3 removes this pre-existing --mode placeholder; until then, freeze the known finding
  // so every additional unsafe argument fails without breaking the required full suite.
  assert.deepEqual(findings, [{ name: 'codex-review.md', flag: '--mode', sequence: '|' }]);
});

test('the dispatcher guard catches mutations using every shared forbidden sequence', () => {
  for (const sequence of SHELL_UNSAFE_SEQUENCES) {
    const mutated = '```bash\ncodex-bridge run --slug "safe' + sequence + 'mutation"\n```';
    assert.deepEqual(
      unsafeArguments(mutated, 'mutated.md'),
      [{ name: 'mutated.md', flag: '--slug', sequence }],
    );
  }
});

test('the order gate denies an unsafe labelled value and passes clean labelled values', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-unsafe-gate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = 'order id: plan-42-build\ntask file: C:/Temp/task-plan-42.md\n';
  const denied = runGate(root, `${base}scope: src/**;tests/**`);
  const decision = JSON.parse(denied.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /scope/);
  assert.match(decision.permissionDecisionReason, /";"/);
  assert.match(decision.permissionDecisionReason, /put free text in the task file/);

  const passed = runGate(root, `${base}scope: src/**,tests/**`);
  assert.equal(passed.status, 0);
  assert.equal(passed.stdout, '');
});
