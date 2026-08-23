/** Holds the platform flags without which a sandboxed run cannot start a process at all. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { codexArgs, unsafeForCmd } from '../../src/home/lib/runner/codex-cmd.mjs';
import { platformSandboxArgs, WINDOWS_SANDBOX } from '../../src/home/lib/runner/sandbox-flags.mjs';
import { loadRunEnv } from '../../src/home/lib/runner/run-env.mjs';

const AGENTS = ['codex-scout', 'codex-build', 'codex-review'];

const argsFor = (agent) => codexArgs(
  { agent, effort: 'medium', repo: process.cwd(), models: {} },
  path.join(os.tmpdir(), 'codex-run'),
  true,
);

test('Windows gets the elevated sandbox key and other platforms get nothing', () => {
  assert.deepEqual(platformSandboxArgs('win32'), ['-c', 'windows.sandbox=elevated']);
  assert.deepEqual(platformSandboxArgs('linux'), []);
  assert.deepEqual(platformSandboxArgs('darwin'), []);
});

// The unelevated token refuses CreateProcess for every command, so a run that omits this key
// reads nothing and still spends its quota (2026-08-23). All three agents need it, including
// codex-build: it survived that day only by inheriting the key from the operator's own config.
test('every agent carries the platform sandbox flags of the host it runs on', () => {
  loadRunEnv();
  for (const agent of AGENTS) {
    const args = argsFor(agent);
    const expected = platformSandboxArgs();
    if (!expected.length) continue;
    const at = args.indexOf(expected[1]);
    assert.notEqual(at, -1, `${agent} is missing ${expected[1]}`);
    assert.equal(args[at - 1], '-c', `${agent} must pass the key as a -c override`);
  }
});

// The whole command line goes through cmd.exe, and unsafeForCmd() refuses any argument holding a
// double quote. A quoted TOML value here would refuse every Windows run instead of fixing it.
test('the sandbox key survives the cmd.exe argument check', () => {
  assert.equal(WINDOWS_SANDBOX.some((arg) => arg.includes('"') || arg.includes('%')), false);
  loadRunEnv();
  for (const agent of AGENTS) assert.equal(unsafeForCmd(argsFor(agent)), undefined, agent);
});
