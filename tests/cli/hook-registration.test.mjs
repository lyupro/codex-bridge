/** Verifies which spelling a hook registration gets, and why. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { hookRegistration } from '../../cli/settings-merge.mjs';

const TARGET = path.join(os.tmpdir(), 'bridge-hooks', 'reply-guard.mjs');
const EMPTY_PATH = { PATH: '' };

test('an unreachable command falls back to the installed copy', () => {
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
  const directory = path.dirname(process.execPath);
  const previous = process.env.PATH;
  t.after(() => { process.env.PATH = previous; });
  const registration = hookRegistration('reply-guard', TARGET, { PATH: directory }, '0.0.0-never');
  assert.equal(registration.form, 'path');
});
