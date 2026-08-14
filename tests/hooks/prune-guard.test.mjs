#!/usr/bin/env node
/** Verifies the prune guard denies agent-issued deletion and passes everything else. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_NAMES } from '../../src/home/lib/cli-names.mjs';
import { SHELL_TOOLS } from '../../src/home/lib/hook-definitions.mjs';

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'home',
  'hooks',
  'prune-guard.mjs',
);

function run(payload) {
  const output = execFileSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });
  return output.trim() ? JSON.parse(output) : null;
}

const decision = (result) => result?.hookSpecificOutput?.permissionDecision ?? null;

test('denies every CLI spelling in every shell tool a host may use', () => {
  for (const name of CLI_NAMES) {
    for (const tool of SHELL_TOOLS) {
      const result = run({ tool_name: tool, tool_input: { command: `${name} prune codex-bridge -f` } });
      assert.equal(decision(result), 'deny', `${name} via ${tool} should be denied`);
      assert.match(result.hookSpecificOutput.permissionDecisionReason, /operator action/);
    }
  }
});

test('denies prune hidden behind a chain, a subshell, or a path', () => {
  const commands = CLI_NAMES.flatMap((name) => [
    `cd /tmp && ${name} prune alpha --purge -f`,
    `echo hi; ${name} prune alpha`,
    `node bin/${name}.mjs prune alpha -f`,
    `C:\\tools\\${name} prune alpha -f`,
  ]);
  for (const command of commands) {
    assert.equal(decision(run({ tool_name: 'Bash', tool_input: { command } })), 'deny', command);
  }
});

test('passes commands that merely contain the word prune', () => {
  // A guard that denied these would break unrelated host work, which is how a guard gets removed.
  const commands = [
    'git prune',
    'npm prune --production',
    'codexb projects',
    'echo "codex-bridge pruning notes"',
  ];
  for (const command of commands) {
    assert.equal(run({ tool_name: 'Bash', tool_input: { command } }), null, command);
  }
});

test('passes read-only run-store commands', () => {
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'codex-bridge projects --json' } }), null);
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'codex-bridge read 2026-08-06_010000_x' } }), null);
});

test('passes anything it cannot recognise instead of breaking the host', () => {
  assert.equal(run('not json at all'), null);
  assert.equal(run({ tool_name: 'Edit', tool_input: { command: 'codex-bridge prune alpha -f' } }), null);
  assert.equal(run({ tool_name: 'Bash', tool_input: {} }), null);
  assert.equal(run({ tool_name: 'Bash' }), null);
});

test('a mention is not an invocation: quoted text and heredoc bodies are data', () => {
  // The guard denied the very commit that introduced it, because the message quoted the command.
  const mentions = [
    `git commit -F - <<'EOF'\nfeat: refuse the prune call\n\nThe command codex-bridge prune deletes artifacts.\nEOF`,
    ...CLI_NAMES.flatMap((name) => [
      `git commit -m 'docs: explain ${name} prune -f'`,
      `echo "run ${name} prune alpha -f yourself"`,
    ]),
  ];
  for (const command of mentions) {
    assert.equal(run({ tool_name: 'Bash', tool_input: { command } }), null, command.slice(0, 40));
  }
});

test('a real call next to a quoted mention is still denied', () => {
  const command = `echo "about to prune"; codex-bridge prune alpha -f`;
  assert.equal(decision(run({ tool_name: 'Bash', tool_input: { command } })), 'deny');
});
