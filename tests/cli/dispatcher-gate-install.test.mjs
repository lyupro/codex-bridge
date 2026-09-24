import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install } from '../../cli/install.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { HOOK_LAUNCHER_PROTOCOL } from '../../cli/hook.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { HOOK_DEFINITIONS } from '../../src/home/lib/hook-definitions.mjs';
import { fixture } from './host-fixture.mjs';

function launcherEnv(t, root) {
  const directory = makeTempTree('dispatcher-launcher-');
  t.after(() => removeTempTree(directory));
  const answer = JSON.stringify({ protocol: HOOK_LAUNCHER_PROTOCOL, dispatch: 'home', homeRoot: root });
  const windows = process.platform === 'win32';
  fsSync.writeFileSync(path.join(directory, windows ? 'codex-bridge.cmd' : 'codex-bridge'),
    windows ? `@echo off\r\nif "%*"=="hook --home" echo ${answer}\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${answer}'\n`, { mode: 0o755 });
  return windows ? { PATH: directory, PATHEXT: '.CMD' } : { PATH: directory };
}

test('dispatcher gate hooks install with exact matchers and uninstall preserves unrelated settings', async (t) => {
  const { host } = await fixture(t);
  const unrelatedHook = { matcher: '*', hooks: [{ type: 'command', command: 'operator-session-hook' }] };
  const initialSettings = { model: 'keep-this', hooks: { SessionStart: [unrelatedHook] } };
  await fs.mkdir(path.dirname(host.settingsPath), { recursive: true });
  await fs.writeFile(host.settingsPath, `${JSON.stringify(initialSettings)}\n`);

  await install({ host, env: launcherEnv(t, host.brandRoot) });
  const installedSettings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  const expected = [
    ['dispatcher-gate', 'PreToolUse', 'Bash|PowerShell|SubagentHandback'],
    ['dispatcher-capture', 'PostToolUse', 'Bash|PowerShell'],
    ['dispatcher-capture-failure', 'PostToolUseFailure', 'Bash|PowerShell'],
  ];
  const actual = HOOK_DEFINITIONS.filter(({ file }) => file === 'dispatcher-gate.mjs')
    .map(({ name, event, matcher }) => [name, event, matcher]);
  assert.deepEqual(actual, expected);
  for (const [name, event, matcher] of expected) {
    assert.ok((installedSettings.hooks[event] || []).some((group) => group.matcher === matcher
      && JSON.stringify(group).includes(`codex-bridge hook ${name}`)), `${event}: ${name}`);
  }

  await uninstall({ host });
  await install({ host, env: { PATH: '' } });
  const pathSettings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  for (const [name, event, matcher] of expected) {
    const command = `node "${path.join(host.brandRoot, 'hooks', 'dispatcher-gate.mjs')}"`;
    const group = (pathSettings.hooks[event] || []).find((entry) => entry.matcher === matcher);
    assert.ok(group?.hooks.some((hook) => hook.command === command), `${event}: ${name} uses installed path`);
  }

  await uninstall({ host });
  const uninstalledSettings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  assert.equal(uninstalledSettings.model, 'keep-this');
  assert.deepEqual(uninstalledSettings.hooks.SessionStart, [unrelatedHook]);
  for (const [name, event] of expected) {
    assert.ok(!(uninstalledSettings.hooks[event] || []).some((group) =>
      JSON.stringify(group).includes(`codex-bridge hook ${name}`)), `${event}: ${name}`);
  }
});
