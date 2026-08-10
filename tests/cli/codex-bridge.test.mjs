/** Verifies dispatcher imports and its public help, version, doctor, and error exits. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../../bin/codex-bridge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BIN = path.join(ROOT, 'bin', 'codex-bridge.mjs');

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

test('importing dispatcher does not execute main', () => {
  assert.equal(typeof main, 'function');
});

test('--help and -h print the command list', () => {
  for (const flag of ['--help', '-h']) {
    const result = run([flag]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Commands:[\s\S]*install[\s\S]*update[\s\S]*uninstall[\s\S]*doctor[\s\S]*unlock/);
    assert.match(result.stdout, /codex-bridge hook <name>/);
  }
});

test('--version and -v print package.json version', async () => {
  const { version } = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  for (const flag of ['--version', '-v']) {
    const result = run([flag]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), version);
  }
});

test('unknown command exits 2 with a useful error', () => {
  const result = run(['unknown']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command "unknown"/);
  assert.match(result.stderr, /--help/);
});

test('the old sweep command refuses with the unlock rename', () => {
  const result = run(['sweep']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /sweep was renamed to codex-bridge unlock/);
  assert.match(result.stderr, /use the new command/);
});

test('shared option parser rejects flags outside each command contract', () => {
  const doctor = run(['doctor', '--dry-run']);
  assert.equal(doctor.status, 2);
  assert.match(doctor.stderr, /unknown doctor option/);
  const uninstall = run(['uninstall', '--force']);
  assert.equal(uninstall.status, 2);
  assert.match(uninstall.stderr, /unknown uninstall option/);
  const update = run(['update', '--unknown']);
  assert.equal(update.status, 2);
  assert.match(update.stderr, /unknown update option/);
});

test('update flags reach the command handler', async (t) => {
  const host = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-bin-update-'));
  t.after(() => fs.rm(host, { recursive: true, force: true }));
  const result = run(['update', '--host', host, '--scope', 'project', '--dry-run', '--force']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not installed/);
  assert.doesNotMatch(result.stderr, /unknown update option/);
});

test('doctor subcommand diagnoses only the explicit temporary host', async (t) => {
  const host = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-bin-doctor-'));
  t.after(() => fs.rm(host, { recursive: true, force: true }));
  const result = run(['doctor', '--host', host]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /installation: not installed/);
  assert.match(result.stdout, new RegExp(host.replaceAll('\\', '\\\\')));
});
