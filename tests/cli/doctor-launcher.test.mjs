/** Verifies hook registration health follows launcher protocol and home proof, not version. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { diagnose } from '../../cli/doctor.mjs';
import { codexProbe, installedFixture, ownPackage } from './doctor-fixtures.mjs';

async function setup(t, command, proof) {
  const { host, record } = await installedFixture(t);
  const recorded = record.hooks.find(({ event }) => event === 'SubagentStop');
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  for (const group of settings.hooks.SubagentStop) {
    for (const hook of group.hooks) {
      if (hook.command === recorded.command && command !== undefined) hook.command = command;
    }
  }
  await fs.writeFile(host.settingsPath, `${JSON.stringify(settings)}\n`);
  const result = await diagnose({
    host,
    codexProbe,
    currentPackage: ownPackage,
    launcherProbe: () => proof,
  });
  return { result, hook: result.checks.find(({ key }) => key === 'hook:SubagentStop') };
}

test('short registration fails and exits nonzero when PATH launcher proof fails', async (t) => {
  const { result, hook } = await setup(t, 'codex-bridge hook reply-guard', {
    ok: false, reason: 'unsupported launcher protocol 1',
  });
  assert.equal(hook.status, 'fail');
  assert.match(hook.value, /unsupported launcher protocol 1/);
  assert.match(hook.value, /codex-bridge update/);
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(hook.value, /version/i);
});

test('short registration is healthy when PATH launcher proof succeeds', async (t) => {
  const { hook } = await setup(t, 'codex-bridge hook reply-guard', { ok: true });
  assert.equal(hook.status, 'ok');
  assert.match(hook.value, /codex-bridge on PATH launches guards from this home/);
  assert.doesNotMatch(hook.value, /version/i);
});

test('path registration suggests update when PATH launcher proof succeeds', async (t) => {
  const { hook } = await setup(t, undefined, { ok: true });
  assert.equal(hook.status, 'warn');
  assert.match(hook.value, /a short command is now safe; run codex-bridge update/);
});

test('path registration remains healthy when PATH launcher proof fails', async (t) => {
  const { hook } = await setup(t, undefined, { ok: false, reason: 'not on PATH' });
  assert.equal(hook.status, 'ok');
});
