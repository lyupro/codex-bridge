/** Verifies the shared PATH resolver required by Plan_60 D2 before a runner starts a command. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCommandOnPath } from '../src/home/lib/command-path.mjs';
import { makeTempTree } from './temp-tree.mjs';

function fixture() {
  const directory = makeTempTree('command-path-');
  const windows = process.platform === 'win32';
  const executable = path.join(directory, windows ? 'tool.cmd' : 'tool');
  fs.writeFileSync(executable, windows ? '@echo off\n' : '#!/bin/sh\nexit 0\n');
  if (!windows) fs.chmodSync(executable, 0o755);
  // The moved resolver preserves PATHEXT casing in its result on Windows.
  const expected = path.join(directory, windows ? 'tool.CMD' : 'tool');
  return { directory, executable, expected, env: { PATH: directory, PATHEXT: '.COM;.EXE;.BAT;.CMD' } };
}

test('finds an executable on PATH using the platform extensions', () => {
  const { env, expected } = fixture();
  assert.equal(resolveCommandOnPath('tool', env), expected);
});

test('returns null for an absent command', () => {
  const { env } = fixture();
  assert.equal(resolveCommandOnPath('absent-tool', env), null);
});

test('skips a PATH entry that is a file without throwing', () => {
  const { env, executable, directory, expected } = fixture();
  assert.equal(resolveCommandOnPath('tool', { ...env, PATH: executable }), null);
  assert.equal(resolveCommandOnPath('tool', {
    ...env, PATH: [executable, directory].join(path.delimiter),
  }), expected);
});

test('honours the Windows Path environment spelling', () => {
  const { directory, env, expected } = fixture();
  assert.equal(resolveCommandOnPath('tool', { Path: directory, PATHEXT: env.PATHEXT }), expected);
});
