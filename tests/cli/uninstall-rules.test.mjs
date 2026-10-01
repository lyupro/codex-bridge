/** Plan_65 B20a: exact dry-run rules decisions stay shared with purge, without installing a host. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileFingerprint } from '../../cli/manifest.mjs';
import { rulesDryRunLines } from '../../cli/uninstall-rules.mjs';

const rulesPath = 'codex-home/rules/codex-bridge.rules';
const host = { root: 'C:/Repos/Current' };

function inputs(fingerprint) {
  return {
    host,
    record: { rules: { path: rulesPath, fingerprint } },
    registry: { version: 1, owners: ['c:/repos/current'] },
    registryError: null,
    detached: true,
  };
}

async function stubFingerprint(t, contents) {
  const read = t.mock.method(fs, 'readFile', async (file) => {
    assert.equal(file, rulesPath);
    return Buffer.from(contents);
  });
  const fingerprint = await fileFingerprint(rulesPath);
  read.mock.resetCalls();
  return { fingerprint, read };
}

function forbidReads(t) {
  return t.mock.method(fs, 'readFile', async () => {
    assert.fail('this branch must not read the rules file');
  });
}

test('a host that remains attached has no rules dry-run lines', async (t) => {
  const read = forbidReads(t);
  assert.deepEqual(await rulesDryRunLines({ ...inputs('recorded'), detached: false }), []);
  assert.equal(read.mock.callCount(), 0);
});

test('a missing installation record has no rules dry-run lines', async (t) => {
  const read = forbidReads(t);
  assert.deepEqual(await rulesDryRunLines({ ...inputs('recorded'), record: null }), []);
  assert.equal(read.mock.callCount(), 0);
});

test('a record without rules metadata has no rules dry-run lines', async (t) => {
  const read = forbidReads(t);
  assert.deepEqual(await rulesDryRunLines({ ...inputs('recorded'), record: {} }), []);
  assert.equal(read.mock.callCount(), 0);
});

test('an invalid registry leaves rules with unknown ownership', async (t) => {
  const read = forbidReads(t);
  assert.deepEqual(await rulesDryRunLines({
    ...inputs('recorded'), registry: null, registryError: new Error('invalid registry'),
  }), [
    `Would leave ${rulesPath} because the rules ownership registry is invalid; ownership is unknown.`,
  ]);
  assert.equal(read.mock.callCount(), 0);
});

test('one other owner uses singular text', async (t) => {
  const { fingerprint } = await stubFingerprint(t, 'unchanged');
  assert.deepEqual(await rulesDryRunLines({
    ...inputs(fingerprint), registry: { version: 1, owners: ['c:/repos/current', 'c:/repos/other'] },
  }), [`Would leave ${rulesPath} because 1 other owner remains.`]);
});

test('multiple other owners use plural text', async (t) => {
  const { fingerprint } = await stubFingerprint(t, 'unchanged');
  assert.deepEqual(await rulesDryRunLines({
    ...inputs(fingerprint),
    registry: { version: 1, owners: ['c:/repos/current', 'c:/repos/other', 'd:/repos/shared'] },
  }), [`Would leave ${rulesPath} because 2 other owners remain.`]);
});

test('an unchanged fingerprint and no other owners would remove rules', async (t) => {
  const { fingerprint, read } = await stubFingerprint(t, 'unchanged');
  assert.deepEqual(await rulesDryRunLines(inputs(fingerprint)), [
    `Would remove ${rulesPath}; no other owners remain and its fingerprint is unchanged.`,
  ]);
  assert.equal(read.mock.callCount(), 1);
});

test('a changed fingerprint would leave rules', async (t) => {
  await stubFingerprint(t, 'operator change');
  assert.deepEqual(await rulesDryRunLines(inputs('original fingerprint')), [
    `Would leave ${rulesPath} because its contents changed after installation.`,
  ]);
});

test('an absent rules file is reported as already absent', async (t) => {
  t.mock.method(fs, 'readFile', async (file) => {
    assert.equal(file, rulesPath);
    throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
  });
  assert.deepEqual(await rulesDryRunLines(inputs('original fingerprint')), [
    `Would leave ${rulesPath} because it is already absent.`,
  ]);
});

test('a missing registry adds its warning after the rules disposition', async (t) => {
  const { fingerprint } = await stubFingerprint(t, 'unchanged');
  assert.deepEqual(await rulesDryRunLines({ ...inputs(fingerprint), registry: null }), [
    `Would remove ${rulesPath}; no other owners remain and its fingerprint is unchanged.`,
    `Warning: the rules ownership registry was missing; other installations may use ${rulesPath}.`,
  ]);
});
