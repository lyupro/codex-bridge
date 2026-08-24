/** Verifies the version-bound memory that detects silent host refusal regressions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CLI_NAMES } from '../../src/home/lib/cli-names.mjs';
import {
  HOST_CONTRACT_RECORD_NAME,
  PROBE_COMMAND,
  contractStatus,
  detectHostVersion,
  hostContractPath,
  parseHostVersion,
  readHostContract,
  writeHostContract,
} from '../../cli/host-contract.mjs';

test('the probe command is built from the canonical CLI name, not spelled out', () => {
  // A second copy of the command in this file would pass while the module named something the CLI
  // no longer answers to — the drift Plan_17 §5 records, reproduced inside its own gate.
  assert.equal(PROBE_COMMAND, `${CLI_NAMES[0]} doctor --probe-contract`);
});

test('no message advises a command the CLI does not answer to yet', () => {
  // `doctor --probe-contract` is not implemented. Until it is, a message naming it would send an
  // operator to `unknown doctor option` — the package spending its credibility on the first line
  // they read. This test fails the day the advice is added without the command.
  const states = [
    { record: null, version: null },
    { record: null, version: '2.1.240' },
    { record: { version: '2.1.231', result: 'honored' }, version: '2.1.240' },
    { record: { version: '2.1.240', result: 'ignored' }, version: '2.1.240' },
    { record: { version: '2.1.240', result: 'honored' }, version: '2.1.240' },
    { record: { version: '2.1.240', result: 'nonsense' }, version: '2.1.240' },
  ];
  for (const input of states) {
    assert.ok(!contractStatus(input).message.includes(PROBE_COMMAND), JSON.stringify(input));
  }
});

test('hostContractPath places the record in the brand root and requires that root', () => {
  assert.equal(
    hostContractPath({ brandRoot: path.join('machine', 'brand') }),
    path.join('machine', 'brand', HOST_CONTRACT_RECORD_NAME),
  );
  assert.throws(() => hostContractPath({}), /host has no brand installation root/);
});

test('contractStatus reports an unknown host, including a caller that omitted the version', () => {
  for (const version of [null, undefined]) {
    const status = contractStatus({ record: null, version });
    assert.equal(status.state, 'unknown-host', String(version));
    assert.match(status.message, /version could not be read/);
  }
});

test('contractStatus reports a machine that has never been probed', () => {
  const status = contractStatus({ record: null, version: '2.1.240' });
  assert.equal(status.state, 'unverified');
  assert.match(status.message, /never been probed/);
  assert.match(status.message, /2\.1\.240/);
});

test('contractStatus reports a record made for another host version', () => {
  const status = contractStatus({
    record: { version: '2.1.231', result: 'honored', checkedAt: '2026-08-23T12:00:00.000Z' },
    version: '2.1.240',
  });
  assert.equal(status.state, 'stale');
  assert.match(status.message, /2\.1\.231/);
  assert.match(status.message, /2\.1\.240/);
});

test('contractStatus loudly names inert guards when refusals are ignored', () => {
  const status = contractStatus({
    record: { version: '2.1.240', result: 'ignored', checkedAt: '2026-08-23T12:00:00.000Z' },
    version: '2.1.240',
  });
  assert.equal(status.state, 'ignored');
  assert.match(status.message, /does not honour hook refusals/);
  assert.match(status.message, /every guard is inert/);
  assert.match(status.message, /order-gate/);
});

test('contractStatus reports a verified refusal contract calmly', () => {
  const status = contractStatus({
    record: { version: '2.1.240', result: 'honored', checkedAt: '2026-08-23T12:00:00.000Z' },
    version: '2.1.240',
  });
  assert.equal(status.state, 'verified');
  assert.match(status.message, /2\.1\.240/);
  assert.match(status.message, /2026-08-23T12:00:00\.000Z/);
});

test('parseHostVersion accepts Claude Code output and rejects non-version text', () => {
  assert.equal(parseHostVersion('2.1.240 (Claude Code)\n'), '2.1.240');
  assert.equal(parseHostVersion(''), null);
  assert.equal(parseHostVersion('not a Claude Code version'), null);
  assert.equal(parseHostVersion('240'), null);
});

test('detectHostVersion parses a successful injected command result', () => {
  const version = detectHostVersion({
    run(command, args, options) {
      assert.equal(command, 'claude');
      assert.deepEqual(args, ['--version']);
      assert.equal(options.shell, false);
      assert.ok(options.timeout <= 5000);
      return { status: 0, stdout: '2.1.240 (Claude Code)\n' };
    },
  });
  assert.equal(version, '2.1.240');
});

test('detectHostVersion returns null for a non-zero exit or timeout', () => {
  assert.equal(detectHostVersion({
    run: () => ({ status: 1, stdout: '2.1.240 (Claude Code)\n' }),
  }), null);
  assert.equal(detectHostVersion({
    run: () => ({ status: null, error: new Error('timed out'), stdout: '' }),
  }), null);
});

test('detectHostVersion returns null when command execution throws', () => {
  assert.equal(detectHostVersion({
    run: () => { throw new Error('host is absent'); },
  }), null);
});

test('readHostContract returns null for a missing file, malformed JSON, or missing version', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-host-contract-read-'));
  const host = { brandRoot: root };
  try {
    assert.equal(await readHostContract(host), null);
    fs.writeFileSync(hostContractPath(host), '{not json', 'utf8');
    assert.equal(await readHostContract(host), null);
    fs.writeFileSync(hostContractPath(host), JSON.stringify({ result: 'honored' }), 'utf8');
    assert.equal(await readHostContract(host), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readHostContract returns the fields from a valid record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-host-contract-valid-'));
  const host = { brandRoot: root };
  const record = {
    version: '2.1.240',
    checkedAt: '2026-08-23T12:00:00.000Z',
    result: 'honored',
  };
  try {
    fs.writeFileSync(hostContractPath(host), JSON.stringify({ ...record, extra: true }), 'utf8');
    assert.deepEqual(await readHostContract(host), record);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeHostContract creates a missing brand root and round-trips atomically', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-host-contract-write-'));
  const host = { brandRoot: path.join(parent, 'missing-brand-root') };
  const now = new Date('2026-08-24T10:30:00.000Z');
  try {
    await writeHostContract(host, { version: '2.1.240', result: 'honored', now });
    assert.deepEqual(await readHostContract(host), {
      version: '2.1.240',
      checkedAt: now.toISOString(),
      result: 'honored',
    });
    const later = new Date('2026-08-24T11:30:00.000Z');
    await writeHostContract(host, { version: '2.1.240', result: 'ignored', now: later });
    assert.deepEqual(await readHostContract(host), {
      version: '2.1.240',
      checkedAt: later.toISOString(),
      result: 'ignored',
    });
    assert.deepEqual(fs.readdirSync(host.brandRoot), [HOST_CONTRACT_RECORD_NAME]);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
