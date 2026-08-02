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
    assert.match(result.stdout, /Commands:\s+doctor/);
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
  const result = run(['install']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command "install"/);
  assert.match(result.stderr, /--help/);
});

test('doctor subcommand diagnoses only the explicit temporary host', async (t) => {
  const host = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-bin-doctor-'));
  t.after(() => fs.rm(host, { recursive: true, force: true }));
  const result = run(['doctor', '--host', host]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /installation: not installed/);
  assert.match(result.stdout, new RegExp(host.replaceAll('\\', '\\\\')));
});
