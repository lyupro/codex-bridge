/** Guards Plan_67 D11 / OW-047: only inventory and legacy change on an operator's declaration. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { INVENTORY_CONFIRM_COMMAND, inventoryConfirm } from '../../cli/inventory-confirm.mjs';
import { readOwnerRoots } from '../../src/home/lib/install-owner-roots.mjs';
import { installRecordPath, readInstallRecordFile } from '../../cli/install-record.mjs';
import { validateFormat2, withOwner } from '../../cli/install-owners.mjs';
import { withLifecycle } from '../../cli/lifecycle-transaction.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import {
  normalizedRulesOwner, RULES_REGISTRY_VERSION, rulesRegistryPath,
} from '../../cli/rules-owners.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

async function writeRawRecord(host, record) {
  await fs.mkdir(host.brandRoot, { recursive: true });
  await fs.writeFile(installRecordPath(host), JSON.stringify(record) + '\n');
}

async function fixture(t, { writeRecord = true } = {}) {
  const root = makeTempTree('bridge-inventory-confirm-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
  const otherHost = resolveHost({
    host: path.join(root, 'other-host'),
    codexHome: host.codexHome,
    brandRoot: host.brandRoot,
  });
  const legacy = {
    name: '@lyupro/codex-bridge', version: '0.1.0',
    installedAt: '2026-08-10T20:00:00.000Z', mode: 'copy',
    files: [
      { root: 'claude', path: 'agents/codex-bridge/dispatcher.md' },
      { root: 'brand', path: 'hooks/reply-guard.mjs' },
    ],
    fingerprints: {
      claude: { 'agents/codex-bridge/dispatcher.md': 'a'.repeat(64) },
      brand: { 'hooks/reply-guard.mjs': 'b'.repeat(64) },
    },
    hooks: [{ event: 'SubagentStop', root: 'brand', path: 'hooks/reply-guard.mjs',
      command: 'codex-bridge hook reply-guard' }],
    rules: { path: path.join(host.codexRulesDir, 'codex-bridge.rules'), fingerprint: 'c'.repeat(64) },
  };
  let record = withOwner(null, host, legacy);
  record = withOwner(record, otherHost, { ...legacy, version: '0.2.0' });
  record.legacy = legacy;
  record.extra = { preserve: ['unknown future field', 42, false] };
  // A4: retain an older owner's actual lag rather than restamping it against the newer image.
  Object.values(record.owners)[0].imageFingerprint = 'd'.repeat(64);
  Object.values(record.owners)[0].createdGroup = true;
  validateFormat2(record);
  if (writeRecord) await writeRawRecord(host, record);
  return { root, host, otherHost, record };
}

test('the hook-side incomplete inventory repair matches the CLI command constant', async (t) => {
  const { host } = await fixture(t);
  const reason = readOwnerRoots({ brandRoot: host.brandRoot });
  assert.equal(INVENTORY_CONFIRM_COMMAND, 'codex-bridge inventory confirm');
  assert.equal(reason.problem, 'inventory-incomplete');
  const command = reason.detail.match(/, run (.+)\.$/);
  assert.ok(command);
  assert.equal(command[1], INVENTORY_CONFIRM_COMMAND);
});

async function recordSnapshot(host) {
  const file = installRecordPath(host);
  const stat = await fs.stat(file);
  return { bytes: await fs.readFile(file), mtime: stat.mtimeMs, ctime: stat.ctimeMs, ino: stat.ino };
}

function noPrompt() {
  assert.fail('this branch must not ask a question');
}

async function seedHints(host, roots) {
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  await fs.writeFile(rulesRegistryPath(host), JSON.stringify({
    version: RULES_REGISTRY_VERSION, owners: roots,
  }) + '\n');
}

test('yes completes inventory, drops legacy, and preserves every other raw field and unrelated file', async (t) => {
  const { root, host, otherHost, record } = await fixture(t);
  const missing = normalizedRulesOwner({ root: path.join(root, 'missing-host') });
  await seedHints(host, [normalizedRulesOwner(host), missing]);
  const sentinels = [
    [path.join(host.brandRoot, 'dispatcher-model.json'), 'model observations'],
    [path.join(host.brandRoot, 'handback-witness.json'), 'witness observations'],
    [path.join(host.brandRoot, 'hooks/reply-guard.mjs'), 'shared image hook'],
    [host.settingsPath, '{"permissions":{"allow":["unchanged"]},"hooks":{}}'],
  ];
  for (const [file, bytes] of sentinels) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  const registryBefore = await fs.readFile(rulesRegistryPath(host));
  let question;
  const result = await inventoryConfirm({ host, isTTY: true, prompt: async (value) => {
    question = value;
    return true;
  } });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Recorded the inventory as complete\./);
  assert.match(question, /Are these all the hosts using this home\?$/);
  assert.ok(question.includes(`Home: ${host.brandRoot}\nRecorded hosts:\n  ${host.root}\n  ${otherHost.root}`));
  assert.ok(question.includes(`  ${missing} (folder does not exist)`));
  assert.ok(question.includes("Confirming lets the last recorded host's uninstall remove the shared image."));
  assert.ok(question.includes('A host that uses this home but is not listed must be enrolled first: '
    + 'codex-bridge install --host "<path>".'));
  const { legacy: _legacy, ...expected } = record;
  expected.inventory = 'complete';
  const actual = await readInstallRecordFile(host);
  assert.deepEqual(actual, expected);
  assert.equal(Object.hasOwn(actual, 'legacy'), false);
  assert.equal(JSON.stringify(actual.owners), JSON.stringify(record.owners));
  assert.equal(JSON.stringify(actual.image), JSON.stringify(record.image));
  for (const [file, bytes] of sentinels) assert.equal(await fs.readFile(file, 'utf8'), bytes);
  assert.deepEqual(await fs.readFile(rulesRegistryPath(host)), registryBefore);
  assert.ok(!(await fs.readdir(host.brandRoot)).some((name) => name.endsWith('.tmp')));
});

for (const [name, answer, exitCode] of [['no', false, 1], ['EOF', undefined, 1], ['cancel', 'cancel', 130]]) {
  test(`${name} leaves the record unwritten`, async (t) => {
    const { host } = await fixture(t);
    const before = await recordSnapshot(host);
    const result = await inventoryConfirm({ host, isTTY: true, prompt: async () => answer });
    assert.equal(result.exitCode, exitCode);
    if (exitCode === 1) assert.match(result.output, /Nothing changed: the inventory stays incomplete\./);
    assert.deepEqual(await recordSnapshot(host), before);
  });
}

test('non-TTY prints the screen and terminal instruction without asking or writing', async (t) => {
  const { host } = await fixture(t);
  const before = await recordSnapshot(host);
  const result = await inventoryConfirm({ host, isTTY: false, prompt: noPrompt });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes(`Home: ${host.brandRoot}`));
  assert.match(result.output, /Recorded hosts:/);
  assert.match(result.output, /Run this command in a terminal to answer\./);
  assert.deepEqual(await recordSnapshot(host), before);
});

test('dry-run shows the screen without a question, prompt, write, or lifecycle acquisition', async (t) => {
  const { host } = await fixture(t);
  const before = await recordSnapshot(host);
  // A nested real acquisition is rejected; dry-run must read even while another lifecycle run owns the home.
  const result = await withLifecycle(host, 'inventory', () => inventoryConfirm({
    host, dryRun: true, isTTY: true, prompt: noPrompt,
  }));
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.includes(`Home: ${host.brandRoot}`));
  assert.match(result.output, /Recorded hosts:/);
  assert.match(result.output, /Dry run: nothing changed\./);
  assert.ok(!result.output.includes('Are these all the hosts using this home?'));
  assert.deepEqual(await recordSnapshot(host), before);
});

test('real confirmation holds the lifecycle lock while asking', async (t) => {
  const { host } = await fixture(t);
  const result = await inventoryConfirm({ host, isTTY: true, prompt: async () => {
    let acquired = false;
    await assert.rejects(withLifecycle(host, 'inventory', () => { acquired = true; }, { waitMs: 0 }));
    assert.equal(acquired, false);
    return false;
  } });
  assert.equal(result.exitCode, 1);
});

test('already complete without legacy is an unwritten idempotent success', async (t) => {
  const { host, record } = await fixture(t);
  record.inventory = 'complete';
  delete record.legacy;
  await writeRawRecord(host, record);
  const before = await recordSnapshot(host);
  const result = await inventoryConfirm({ host, isTTY: false, prompt: noPrompt });
  assert.deepEqual(result, { exitCode: 0, output: 'The inventory is already complete.' });
  assert.deepEqual(await recordSnapshot(host), before);
});

test('complete inventory with legacy still requires confirmation and removes only legacy', async (t) => {
  const { host, record } = await fixture(t);
  record.inventory = 'complete';
  await writeRawRecord(host, record);
  let calls = 0;
  const result = await inventoryConfirm({ host, isTTY: true, prompt: async () => { calls += 1; return true; } });
  assert.equal(result.exitCode, 0);
  assert.equal(calls, 1);
  const { legacy: _legacy, ...expected } = record;
  assert.deepEqual(await readInstallRecordFile(host), expected);
});

test('incomplete inventory without legacy can be confirmed', async (t) => {
  const { host, record } = await fixture(t);
  delete record.legacy;
  await writeRawRecord(host, record);
  const result = await inventoryConfirm({ host, isTTY: true, prompt: async () => true });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(await readInstallRecordFile(host), { ...record, inventory: 'complete' });
});

test('no record names update and does not create a missing home', async (t) => {
  const { host } = await fixture(t, { writeRecord: false });
  const result = await inventoryConfirm({ host, isTTY: true, prompt: noPrompt });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /codex-bridge update/);
  await assert.rejects(fs.access(host.brandRoot), { code: 'ENOENT' });
});

test('a missing home refuses before a record read can create the home', async (t) => {
  const { host, record } = await fixture(t, { writeRecord: false });
  const readFile = fs.readFile;
  let reads = 0;
  // Plan_67 R2: model a first install becoming visible during the unlocked record read.
  t.mock.method(fs, 'readFile', async (...args) => {
    reads += 1;
    await writeRawRecord(host, record);
    return readFile(...args);
  });
  const result = await inventoryConfirm({ host, isTTY: true, prompt: async () => true });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /No format-2 installation record was found.*codex-bridge update/);
  assert.equal(reads, 0, 'no record read is allowed without a lifecycle ticket');
  await assert.rejects(fs.access(installRecordPath(host)), { code: 'ENOENT' });
  await assert.rejects(fs.access(host.brandRoot), { code: 'ENOENT' });
});

test('format 1 names update without writing or asking', async (t) => {
  const { host, record } = await fixture(t);
  await writeRawRecord(host, record.legacy);
  const before = await recordSnapshot(host);
  const result = await inventoryConfirm({ host, isTTY: true, prompt: noPrompt });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /codex-bridge update/);
  assert.deepEqual(await recordSnapshot(host), before);
});

test('zero owners refuses confirmation without writing', async (t) => {
  const { host, record } = await fixture(t);
  record.owners = {};
  await writeRawRecord(host, record);
  const before = await recordSnapshot(host);
  const result = await inventoryConfirm({ host, isTTY: true, prompt: noPrompt });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /no recorded owners; install into each host first/);
  assert.deepEqual(await recordSnapshot(host), before);
});

for (const [name, damage] of [
  ['inventory', (record) => { record.inventory = 'unknown'; }],
  ['owners', (record) => { record.owners = null; }],
  ['fingerprint', (record) => { Object.values(record.owners)[0].imageFingerprint = 'invalid'; }],
  ['legacy', (record) => { record.legacy = {}; }],
]) {
  test(`invalid ${name} names update without asking or writing`, async (t) => {
    const { host, record } = await fixture(t);
    damage(record);
    await writeRawRecord(host, record);
    const before = await recordSnapshot(host);
    const result = await inventoryConfirm({ host, isTTY: true, prompt: noPrompt });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /codex-bridge update/);
    assert.deepEqual(await recordSnapshot(host), before);
  });
}

test('invalid JSON names update without asking or writing', async (t) => {
  const { host } = await fixture(t);
  await fs.writeFile(installRecordPath(host), '{');
  const before = await recordSnapshot(host);
  const result = await inventoryConfirm({ host, isTTY: true, prompt: noPrompt });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /codex-bridge update/);
  assert.deepEqual(await recordSnapshot(host), before);
});
