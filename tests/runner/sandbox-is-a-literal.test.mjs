/** Holds the sandbox of every runner command to the literal its agent is entitled to. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { codexArgs } from '../../src/home/lib/runner/codex-args.mjs';
import { loadRunEnv } from '../../src/home/lib/runner/run-env.mjs';

const SANDBOX_BY_AGENT = new Map([
  ['codex-scout', 'read-only'],
  ['codex-build', 'workspace-write'],
  ['codex-review', 'read-only'],
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

  const literalSandboxes = [...codexArgs.toString().matchAll(
    /['"]--sandbox['"]\s*,\s*['"](read-only|workspace-write)['"]/g,
  )].map((match) => match[1]);
  assert.deepEqual(
    literalSandboxes,
    ['read-only', 'workspace-write', 'read-only'],
    'sandbox values must remain literals in codexArgs; configuration would weaken this guard',
  );
});
