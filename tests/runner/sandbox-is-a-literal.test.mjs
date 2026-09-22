/** Holds the sandbox of every runner command to the literal its agent is entitled to. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { codexArgs, sandboxModeFor } from '../../src/home/lib/runner/codex-args.mjs';
import { loadRunEnv } from '../../src/home/lib/runner/run-env.mjs';

const SANDBOX_BY_AGENT = new Map([
  ['codex-scout', 'read-only'],
  ['codex-build', 'workspace-write'],
  ['codex-review', 'read-only'],
  ['codex-advisor', 'read-only'],
]);

test('every runner command has exactly its one literal contract sandbox', () => {
  loadRunEnv();
  const runDir = path.join(os.tmpdir(), 'codex-run');

  for (const [agent, expectedSandbox] of SANDBOX_BY_AGENT) {
    const args = codexArgs(
      { agent, effort: 'medium', repo: process.cwd(), models: {} },
      runDir,
      true,
    );
    const sandboxFlags = args.flatMap((arg, index) => arg === '--sandbox' ? [index] : []);

    assert.deepEqual(sandboxFlags, [args.indexOf('--sandbox')], agent);
    assert.equal(args[sandboxFlags[0] + 1], expectedSandbox, agent);
    assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false, agent);
  }

  // Plan_57 moved the literals into sandboxModeFor(), because the pre-run sandbox probe has to ask
  // for exactly the permissions the run will. The guard's point (Plan_34) is unchanged: the value
  // is a literal chosen by agent name, never read from configuration or options.
  const literalSandboxes = [...sandboxModeFor.toString().matchAll(
    /return\s+['"](read-only|workspace-write)['"]/g,
  )].map((match) => match[1]);
  assert.deepEqual(
    literalSandboxes,
    ['workspace-write', 'read-only'],
    'sandbox values must remain literals in sandboxModeFor; configuration would weaken this guard',
  );
  assert.doesNotMatch(sandboxModeFor.toString(), /\b(?:opts|env|config|process)\b/);
  const source = codexArgs.toString();
  assert.match(source, /const sandboxMode = sandboxModeFor\(opts\.agent\);/);
  const sandboxValues = [...source.matchAll(/['"]--sandbox['"]\s*,\s*([^,\s]+)/g)].map((match) => match[1]);
  assert.deepEqual(sandboxValues, ['sandboxMode', 'sandboxMode', 'sandboxMode']);
  assert.throws(() => sandboxModeFor('codex-unknown'));
});
