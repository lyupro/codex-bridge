/** Verifies which spelling a hook registration gets, and why. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandReachable, hookRegistration, reachableCommandVersion } from '../../cli/settings-merge.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const TARGET = path.join(os.tmpdir(), 'bridge-hooks', 'reply-guard.mjs');
const EMPTY_PATH = { PATH: '' };

function versionShim(t, version, directoryName = 'bin with space & (x86)') {
  const root = makeTempTree('hook-registration-');
  t.after(() => removeTempTree(root));
  const directory = path.join(root, directoryName);
  fs.mkdirSync(directory);
  const windows = process.platform === 'win32';
  fs.writeFileSync(path.join(directory, windows ? 'codex-bridge.cmd' : 'codex-bridge'),
    windows ? `@echo off\r\necho ${version}\r\n` : `#!/bin/sh\nprintf '%s\\n' '${version}'\n`,
    { mode: 0o755 });
  // PATH holds the shim and nothing else, the operator's global codex-bridge included. The
  // interpreter is deliberately absent: the module takes it from ComSpec, so a PATH without
  // System32 must still read the version.
  return windows ? { PATH: directory, PATHEXT: '.CMD' } : { PATH: directory };
}

test('an unreachable command falls back to the installed copy', () => {
  assert.equal(commandReachable('codex-bridge', EMPTY_PATH), false);
  assert.equal(reachableCommandVersion('codex-bridge', EMPTY_PATH), null);
  const registration = hookRegistration('reply-guard', TARGET, EMPTY_PATH, '9.9.9');
  assert.equal(registration.form, 'path');
  assert.match(registration.command, /reply-guard\.mjs/);
  assert.match(registration.reason, /not reachable from PATH/);
});

test('a version this package cannot state falls back too', () => {
  // The short form promises a command that will run *this* code. Without a version to compare, the
  // promise cannot be kept, so the safe spelling wins.
  const registration = hookRegistration('reply-guard', TARGET, EMPTY_PATH, null);
  assert.equal(registration.form, 'path');
});

test('a command of another version does not get the short form', (t) => {
  // Reproduces 2026-08-11: an install from the clone wrote `codex-bridge hook <name>` while the
  // command on PATH was the previous release, which has no such subcommand. Every guard then
  // failed before deciding anything and the host refused Bash, edits and agent launches.
  const env = versionShim(t, '1.2.3');
  const registration = hookRegistration('reply-guard', TARGET, env, '9.9.9');
  assert.equal(registration.form, 'path');
  assert.match(registration.command, /reply-guard\.mjs/);
  assert.match(registration.reason, /on PATH reports 1\.2\.3, not 9\.9\.9/);
});

test('reachableCommandVersion reads a shim in a directory with shell metacharacters', (t) => {
  const env = versionShim(t, '1.2.3');
  assert.equal(commandReachable('codex-bridge', env), true);
  assert.equal(reachableCommandVersion('codex-bridge', env), '1.2.3');
});

test('a matching command version gets the short form', (t) => {
  const env = versionShim(t, '9.9.9');
  const registration = hookRegistration('reply-guard', TARGET, env, '9.9.9');
  assert.equal(registration.form, 'short');
  assert.equal(registration.command, 'codex-bridge hook reply-guard');
});

for (const directory of ['plain', 'bin with space', 'Program Files (x86)', 'weird & name', 'caret^dir']) {
  test(`reachableCommandVersion preserves the shim path in ${directory}`, (t) => {
    assert.equal(reachableCommandVersion('codex-bridge', versionShim(t, '1.2.3', directory)), '1.2.3');
  });
}

test('reachableCommandVersion uses the first matching PATH entry', (t) => {
  const first = versionShim(t, '1.2.3');
  const second = versionShim(t, '9.9.9');
  const env = { ...first, PATH: [first.PATH, second.PATH].join(path.delimiter) };
  assert.equal(reachableCommandVersion('codex-bridge', env), '1.2.3');
});

test('reachableCommandVersion resolves relative PATH entries', (t) => {
  const env = versionShim(t, '1.2.3');
  env.PATH = env.PATH.split(path.delimiter).map((directory) => path.relative(process.cwd(), directory))
    .join(path.delimiter);
  assert.equal(reachableCommandVersion('codex-bridge', env), '1.2.3');
});
