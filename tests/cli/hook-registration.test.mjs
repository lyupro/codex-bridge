/** Verifies launcher-based hook registration and reachable version probes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandReachable, reachableCommandVersion } from '../../cli/settings-merge.mjs';
import { probeHookLauncher } from '../../cli/launcher-probe.mjs';
import { hookRegistration } from '../../cli/settings-merge.mjs';
import { HOOK_LAUNCHER_PROTOCOL } from '../../cli/hook.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const TARGET = path.join(os.tmpdir(), 'bridge-hooks', 'reply-guard.mjs');
const EMPTY_PATH = { PATH: '' };
const BRAND_ROOT = path.join(os.tmpdir(), 'bridge-brand');

function shim(t, script, directoryName = 'bin with space & (x86)') {
  const root = makeTempTree('hook-registration-');
  t.after(() => removeTempTree(root));
  const directory = path.join(root, directoryName);
  fs.mkdirSync(directory);
  const windows = process.platform === 'win32';
  fs.writeFileSync(path.join(directory, windows ? 'codex-bridge.cmd' : 'codex-bridge'),
    windows ? `@echo off\r\n${script}\r\n` : `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return windows ? { PATH: directory, PATHEXT: '.CMD' } : { PATH: directory };
}

function launcherShim(t, { root = BRAND_ROOT, status = 0, answer, versionOnly = false } = {}) {
  const payload = answer ?? JSON.stringify({ protocol: HOOK_LAUNCHER_PROTOCOL, dispatch: 'home', homeRoot: root });
  const command = process.platform === 'win32'
    ? `if "%*"=="hook --home" (echo ${payload}& exit /b ${status})\nif "%*"=="--version" (echo 0.6.6& exit /b 0)\necho rejected 1>&2& exit /b 1`
    : `if [ "$1 $2" = "hook --home" ]; then printf '%s\\n' '${payload}'; exit ${status}; fi\nif [ "$1" = "--version" ]; then printf '%s\\n' '0.6.6'; exit 0; fi\nexit 1`;
  return shim(t, versionOnly ? (process.platform === 'win32'
    ? 'echo 0.6.6' : "printf '%s\\n' 0.6.6") : command);
}

function registration(env, brandRoot = BRAND_ROOT) {
  const probe = probeHookLauncher({ env, brandRoot });
  return { probe, result: hookRegistration('reply-guard', TARGET, probe) };
}

test('an unreachable command uses the installed path form', () => {
  assert.equal(commandReachable('codex-bridge', EMPTY_PATH), false);
  const { result } = registration(EMPTY_PATH);
  assert.equal(result.form, 'path');
  assert.match(result.reason, /not on PATH/);
});

test('a launcher for this home gets the short form', (t) => {
  const { probe, result } = registration(launcherShim(t));
  assert.equal(probe.ok, true);
  assert.equal(result.form, 'short');
  assert.equal(result.command, 'codex-bridge hook reply-guard');
  assert.match(result.reason, /launches guards from this home/);
});

test('Windows launcher roots compare case-insensitively and with slash normalization', (t) => {
  const alternate = BRAND_ROOT.replaceAll('\\', '/').toUpperCase().replace(/\/$/, '');
  const { result } = registration(launcherShim(t, { root: alternate }), BRAND_ROOT);
  assert.equal(result.form, process.platform === 'win32' ? 'short' : 'path');
});

test('a launcher for a different home names both roots', (t) => {
  const other = path.join(os.tmpdir(), 'other-brand');
  const { result } = registration(launcherShim(t, { root: other }));
  assert.equal(result.form, 'path');
  assert.match(result.reason, new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.reason, new RegExp(BRAND_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a version-only shim does not prove launcher identity', (t) => {
  const { result } = registration(launcherShim(t, { versionOnly: true }));
  assert.equal(result.form, 'path');
});

for (const [label, answer, status] of [
  ['invalid JSON', '{invalid', 0],
  ['unsupported protocol', JSON.stringify({ protocol: 2, dispatch: 'home', homeRoot: BRAND_ROOT }), 0],
  ['wrong dispatch', JSON.stringify({ protocol: HOOK_LAUNCHER_PROTOCOL, dispatch: 'package', homeRoot: BRAND_ROOT }), 0],
  ['non-zero exit', JSON.stringify({ protocol: HOOK_LAUNCHER_PROTOCOL, dispatch: 'home', homeRoot: BRAND_ROOT }), 1],
]) {
  test(`${label} uses the path form`, (t) => {
    const { result } = registration(launcherShim(t, { answer, status }));
    assert.equal(result.form, 'path');
  });
}

test('reachableCommandVersion remains compatible', (t) => {
  const env = shim(t, process.platform === 'win32' ? 'echo 1.2.3' : "printf '%s\\n' '1.2.3'");
  assert.equal(reachableCommandVersion('codex-bridge', env), '1.2.3');
});

for (const directory of ['plain', 'bin with space', 'Program Files (x86)', 'weird & name', 'caret^dir']) {
  test(`launcher probe preserves shim paths in ${directory}`, (t) => {
    const env = launcherShim(t, { root: BRAND_ROOT }, directory);
    const probed = registration(env);
    assert.equal(probed.result.form, 'short');
  });
}

test('reachableCommandVersion uses the first matching PATH entry', (t) => {
  const first = shim(t, process.platform === 'win32' ? 'echo 1.2.3' : "printf '%s\\n' '1.2.3'");
  const second = shim(t, process.platform === 'win32' ? 'echo 9.9.9' : "printf '%s\\n' '9.9.9'");
  assert.equal(reachableCommandVersion('codex-bridge', { ...first, PATH: [first.PATH, second.PATH].join(path.delimiter) }), '1.2.3');
});

test('reachableCommandVersion resolves relative PATH entries', (t) => {
  const env = shim(t, process.platform === 'win32' ? 'echo 1.2.3' : "printf '%s\\n' '1.2.3'");
  env.PATH = path.relative(process.cwd(), env.PATH);
  assert.equal(reachableCommandVersion('codex-bridge', env), '1.2.3');
});
