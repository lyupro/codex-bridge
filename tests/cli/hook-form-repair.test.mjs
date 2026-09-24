import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { install } from '../../cli/install.mjs';
import { update } from '../../cli/update.mjs';
import { hookTargets } from '../../cli/hook-targets.mjs';
import { readInstallRecord } from '../../cli/manifest.mjs';
import { fixture } from './host-fixture.mjs';
import { launcherEnv } from './launcher-shim.mjs';

test('update repairs registration form, records it, and is byte-idempotent', async (t) => {
  const { host } = await fixture(t);
  await install({ host, env: launcherEnv(t, host.brandRoot) });
  const pathEnv = { PATH: '' };
  const repaired = await update({ host, env: pathEnv });
  assert.equal(repaired.exitCode, 0);
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  const targets = hookTargets(host, pathEnv);
  for (const target of targets) {
    const hooks = settings.hooks[target.definition.event].flatMap((group) => group.hooks);
    assert.equal(hooks.filter((entry) => entry.command === target.spec.command).length, 1);
  }
  const record = await readInstallRecord(host);
  for (const target of targets) {
    assert.equal(record.hooks.find((hook) => hook.event === target.definition.event
      && hook.path === target.relative).command, target.spec.command);
  }
  const before = await fs.readFile(host.settingsPath, 'utf8');
  assert.match((await update({ host, env: pathEnv })).output, /up to date/);
  assert.equal(await fs.readFile(host.settingsPath, 'utf8'), before);
});

test('update dry-run describes stale registration form and writes nothing', async (t) => {
  const { host } = await fixture(t);
  await install({ host, env: launcherEnv(t, host.brandRoot) });
  const before = await fs.readFile(host.settingsPath, 'utf8');
  const result = await update({ host, env: { PATH: '' }, dryRun: true });
  assert.match(result.output, /Would rewrite .* hook .* for matcher .* to path command:/);
  assert.equal(await fs.readFile(host.settingsPath, 'utf8'), before);
});

test('update switches path registrations to the short form when a proven launcher appears', async (t) => {
  const { host } = await fixture(t);
  await install({ host, env: { PATH: '' } });
  const env = launcherEnv(t, host.brandRoot);
  assert.equal((await update({ host, env })).exitCode, 0);
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  const targets = hookTargets(host, env);
  for (const target of targets) {
    const expected = `codex-bridge hook ${target.definition.name}`;
    assert.equal(settings.hooks[target.definition.event].flatMap((group) => group.hooks)
      .filter((entry) => entry.command === expected).length, 1);
  }
});

test('duplicate forms under two matchers converge to one entry that keeps the declared group\'s fields', async (t) => {
  const { host } = await fixture(t);
  await install({ host, env: { PATH: '' } });
  const [target] = hookTargets(host, { PATH: '' }).filter(({ definition }) => definition.name === 'order-gate');
  const { event, matcher, name } = target.definition;
  const short = `codex-bridge hook ${name}`;
  const foreign = { type: 'command', command: 'operator-own-hook' };
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  settings.hooks[event] = settings.hooks[event]
    .map((group) => ({ ...group, hooks: group.hooks.filter((hook) => hook.command !== target.spec.command) }))
    .filter((group) => group.hooks.length);
  settings.hooks[event].push(
    { matcher, hooks: [foreign, { type: 'command', command: short, timeout: 7 }] },
    { matcher: 'Task', hooks: [{ type: 'command', command: target.spec.command }] },
  );
  await fs.writeFile(host.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  const env = launcherEnv(t, host.brandRoot);
  assert.equal((await update({ host, env })).exitCode, 0);
  const after = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  const own = after.hooks[event].flatMap((group) => group.hooks.map((hook) => ({ group, hook })))
    .filter(({ hook }) => hook.command === short || hook.command === target.spec.command);
  assert.equal(own.length, 1);
  assert.equal(own[0].group.matcher, matcher);
  assert.deepEqual(own[0].hook, { type: 'command', command: short, timeout: 7 });
  assert.ok(own[0].group.hooks.some((hook) => hook.command === foreign.command));
  assert.ok(!after.hooks[event].some((group) => group.matcher === 'Task'));
});
