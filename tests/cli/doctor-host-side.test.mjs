/** Verifies doctor host marks and shared-home owner reporting. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { diagnose } from '../../cli/doctor.mjs';
import { homeOwnersCheck, hostSideCheck, ownersInSyncCheck } from '../../cli/doctor-host-side.mjs';
import { install } from '../../cli/install.mjs';
import { INVENTORY_CONFIRM_COMMAND } from '../../cli/inventory-confirm.mjs';
import { imageFingerprint } from '../../cli/install-owners.mjs';
import { installRecordPath } from '../../cli/install-record.mjs';
import { buildInstallPlan, fileFingerprint } from '../../cli/manifest.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';
import { codexProbe, ownPackage } from './doctor-fixtures.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

async function temporaryHost(t) {
  const root = makeTempTree('bridge-doctor-host-side-');
  t.after(() => removeTempTree(root));
  return resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
}

test('host files fails when settings could not be read', () => {
  const result = hostSideCheck(
    { root: 'C:/host' },
    { files: [], hooks: [], settingsError: 'invalid JSON' },
  );
  assert.deepEqual(result, {
    key: 'host files',
    status: 'fail',
    value: 'settings could not be read: invalid JSON',
  });
});

test('host files warns when there are no package marks', () => {
  const result = hostSideCheck(
    { root: 'C:/host' },
    { files: [], hooks: [], settingsError: null },
  );
  assert.deepEqual(result, {
    key: 'host files',
    status: 'warn',
    value: 'no codex-bridge files or hooks in C:/host',
  });
});

test('host files reports package file and own hook counts', () => {
  const result = hostSideCheck(
    { root: 'C:/host' },
    {
      files: [{ relativeToHost: 'agents/bridge.md', disposition: 'remove', reason: 'matches package' }],
      hooks: [{ event: 'Stop' }],
      settingsError: null,
    },
  );
  assert.deepEqual(result, {
    key: 'host files',
    status: 'ok',
    value: '1 package file(s) and 1 own hook(s) in C:/host',
  });
});

test('host files warns and names kept changed and unknown files', () => {
  const result = hostSideCheck(
    { root: 'C:/host' },
    {
      files: [
        { relativeToHost: 'agents/edited.md', disposition: 'keep', reason: 'changed' },
        { relativeToHost: 'agents/legacy.md', disposition: 'keep', reason: 'unknown' },
      ],
      hooks: [],
      settingsError: null,
    },
  );
  assert.equal(result.status, 'warn');
  assert.match(result.value, /kept by uninstall: agents\/edited\.md \(changed\), agents\/legacy\.md \(unknown\)/);
});

test('home owners distinguishes no record with and without a home image', async (t) => {
  const host = await temporaryHost(t);
  const inspection = { files: [], hooks: [], settingsError: null };
  const empty = await homeOwnersCheck(host, null, inspection);
  assert.equal(empty.status, 'ok');
  assert.equal(empty.value, `no installation record in ${host.brandRoot}`);
  await fs.mkdir(path.join(host.brandRoot, 'lib'), { recursive: true });
  const orphanedImage = await homeOwnersCheck(host, null, inspection);
  assert.equal(orphanedImage.status, 'warn');
  assert.equal(orphanedImage.value, `no installation record in ${host.brandRoot}; the image has no record`);
});

test('home owners warns for format 1 without changing the record bytes', async (t) => {
  const host = await temporaryHost(t);
  await fs.mkdir(host.brandRoot, { recursive: true });
  const recordPath = path.join(host.brandRoot, '.installed.json');
  const recordBytes = Buffer.from('{"format":1,"owners":{}}\n');
  await fs.writeFile(recordPath, recordBytes);
  const before = await fs.readFile(recordPath);
  const result = await homeOwnersCheck(host, JSON.parse(before.toString('utf8')), {
    files: [],
    hooks: [],
    settingsError: null,
  });
  const after = await fs.readFile(recordPath);
  assert.equal(result.status, 'warn');
  assert.equal(result.value, 'old record format; the hosts using this home are unknown until the next install or update');
  assert.deepEqual(after, before);
});

test('home owners lists this host for a complete format 2 record', async (t) => {
  const host = await temporaryHost(t);
  const result = await homeOwnersCheck(host, {
    format: 2,
    inventory: 'complete',
    owners: { [normalizeRepoPath(host.root)]: { root: host.root } },
  }, {
    files: [{ relativeToHost: 'agents/bridge.md' }],
    hooks: [],
    settingsError: null,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.value, `recorded: ${host.root}; inventory complete`);
});

test('home owners warns for an incomplete format 2 inventory', async (t) => {
  const host = await temporaryHost(t);
  const result = await homeOwnersCheck(host, {
    format: 2,
    inventory: 'incomplete',
    owners: { [normalizeRepoPath(host.root)]: { root: host.root } },
  }, { files: [], hooks: [], settingsError: null });
  assert.equal(result.status, 'warn');
  assert.equal(result.value, `recorded: ${host.root}; inventory incomplete: an old record did not name every host; run ${INVENTORY_CONFIRM_COMMAND} if the recorded hosts are all of them`);
});

test('home owners warns with an install hint for marks without an owner row', async (t) => {
  const host = await temporaryHost(t);
  const result = await homeOwnersCheck(host, {
    format: 2,
    inventory: 'incomplete',
    owners: {},
  }, {
    files: [{ relativeToHost: 'agents/bridge.md' }],
    hooks: [],
    settingsError: null,
  });
  assert.equal(result.status, 'warn');
  assert.equal(result.value, `recorded: none; inventory incomplete: an old record did not name every host; install into each host first: run codex-bridge install --host "<path>"; ${host.root} has package files or hooks but is not recorded: run codex-bridge install --host "${host.root}"`);
});

test('ownerless incomplete home inventory recommends enrolling each host without marks', async (t) => {
  const host = await temporaryHost(t);
  const result = await homeOwnersCheck(host, { format: 2, inventory: 'incomplete', owners: {} },
    { files: [], hooks: [], settingsError: null });
  assert.equal(result.status, 'warn');
  assert.match(result.value, /inventory incomplete/);
  assert.ok(result.value.includes('codex-bridge install --host "<path>"'));
  assert.doesNotMatch(result.value, /inventory confirm/);
});

test('incomplete inventory and unrecorded package marks each name their repair', async (t) => {
  const host = await temporaryHost(t);
  const record = syncRecord();
  record.inventory = 'incomplete';
  const incomplete = await homeOwnersCheck(host, record, {
    files: [{ relativeToHost: 'agents/bridge.md' }], hooks: [], settingsError: null,
  });
  assert.equal(incomplete.status, 'warn');
  assert.ok(incomplete.value.includes(`inventory incomplete: an old record did not name every host; run ${INVENTORY_CONFIRM_COMMAND}`));
  assert.ok(incomplete.value.includes(`codex-bridge install --host "${host.root}"`));
});

function syncRecord() {
  const image = { version: '2.0.0', fingerprints: { brand: { 'lib/image.mjs': 'current' } } };
  const owners = Object.fromEntries(['C:/host one', 'C:/host two'].map((root) => [root, {
    root, version: image.version, imageFingerprint: imageFingerprint(image),
  }]));
  return { format: 2, inventory: 'complete', image, owners };
}

const verificationNote = '(recorded verification; host files and reachability not inspected)';

test('owners in sync makes no owner claim without a format 2 record', () => {
  for (const record of [null, { format: 1, owners: { 'C:/old host': { root: 'C:/old host' } } }]) {
    assert.deepEqual(ownersInSyncCheck(record), {
      key: 'owners in sync', status: 'ok', value: 'no format-2 record; nothing to compare',
    });
  }
});

test('owners in sync warns when no owners are recorded', () => {
  assert.deepEqual(ownersInSyncCheck({ format: 2, inventory: 'complete', owners: {} }), {
    key: 'owners in sync', status: 'warn', value: 'no recorded owners',
  });
});

test('owners in sync accepts both current stamps without inspecting hosts or changing the record', () => {
  const record = syncRecord();
  const before = structuredClone(record);
  assert.deepEqual(ownersInSyncCheck(record), {
    key: 'owners in sync', status: 'ok',
    value: `all 2 owner(s) verified against the current image ${verificationNote}`,
  });
  assert.deepEqual(record, before);
});

test('owners in sync names only the older stamp even when its version matches', () => {
  const record = syncRecord();
  record.owners['C:/host one'].imageFingerprint = imageFingerprint({
    version: record.image.version, fingerprints: { brand: { 'lib/image.mjs': 'older' } },
  });
  assert.deepEqual(ownersInSyncCheck(record), {
    key: 'owners in sync', status: 'warn',
    value: `C:/host one (verified against an earlier image of 2.0.0): run codex-bridge update --host "C:/host one" ${verificationNote}`,
  });
});

test('owners in sync uses the image stamp before the recorded version', () => {
  const record = syncRecord();
  record.owners['C:/host one'].version = '1.0.0';
  assert.equal(ownersInSyncCheck(record).status, 'ok');
});

test('owners in sync groups equal-version owners without stamps into one warning', () => {
  const record = syncRecord();
  for (const owner of Object.values(record.owners)) delete owner.imageFingerprint;
  assert.deepEqual(ownersInSyncCheck(record), {
    key: 'owners in sync', status: 'warn',
    value: `not yet verified by image fingerprint: C:/host one, C:/host two ${verificationNote}`,
  });
});

test('owners in sync asks an unstamped older-version owner to update', () => {
  const record = syncRecord();
  delete record.owners['C:/host one'].imageFingerprint;
  record.owners['C:/host one'].version = '1.0.0';
  assert.deepEqual(ownersInSyncCheck(record), {
    key: 'owners in sync', status: 'warn',
    value: `C:/host one (recorded 1.0.0, image 2.0.0): run codex-bridge update --host "C:/host one" ${verificationNote}`,
  });
});

test('owners in sync never marks an incomplete or legacy inventory healthy', () => {
  for (const inventory of [{ inventory: 'incomplete' }, { inventory: undefined }, { legacy: {} }]) {
    const record = { ...syncRecord(), ...inventory };
    assert.deepEqual(ownersInSyncCheck(record), {
      key: 'owners in sync', status: 'warn', value: `inventory incomplete; run ${INVENTORY_CONFIRM_COMMAND} if the recorded hosts are all of them ${verificationNote}`,
    });
  }
  assert.equal(ownersInSyncCheck({ format: 2, owners: {} }).value,
    `no recorded owners; inventory incomplete; install into each host first: run codex-bridge install --host "<path>"`);
});

test('owners in sync joins lagging, unstamped and incomplete inventory warnings', () => {
  const record = syncRecord();
  record.inventory = 'incomplete';
  record.owners['C:/host one'].imageFingerprint = 'older stamp';
  delete record.owners['C:/host two'].imageFingerprint;
  assert.deepEqual(ownersInSyncCheck(record), {
    key: 'owners in sync', status: 'warn',
    value: `C:/host one (verified against an earlier image of 2.0.0): run codex-bridge update --host "C:/host one"; not yet verified by image fingerprint: C:/host two; inventory incomplete; run ${INVENTORY_CONFIRM_COMMAND} if the recorded hosts are all of them ${verificationNote}`,
  });
});

test('doctor reports host marks and recorded owners after a real install', async (t) => {
  const host = await temporaryHost(t);
  await install({ host });
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const installationIndex = result.checks.findIndex((item) => item.key === 'installation');
  const filesCheck = result.checks.find((item) => item.key === 'host files');
  const ownersCheck = result.checks.find((item) => item.key === 'home owners');
  assert.equal(result.checks[installationIndex + 1].key, 'host files');
  assert.equal(result.checks[installationIndex + 2].key, 'home owners');
  assert.equal(filesCheck.status, 'ok');
  assert.match(filesCheck.value, /\d+ package file\(s\) and \d+ own hook\(s\)/);
  assert.equal(ownersCheck.status, 'ok');
  assert.ok(ownersCheck.value.includes(host.root));
});

// Doctor inspects with this host's owner row, like uninstall: an edit whose fingerprint the row
// records is removed by uninstall, so doctor must not list it as kept.
test('doctor judges edited host files with the owner row, as uninstall does', async (t) => {
  const host = await temporaryHost(t);
  await install({ host });
  const plan = await buildInstallPlan(host);
  const item = plan.find((candidate) => candidate.target.startsWith(host.agentsDir + path.sep));
  await fs.writeFile(item.target, 'operator edit');
  const edited = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const keptCheck = edited.checks.find((entry) => entry.key === 'host files');
  assert.equal(keptCheck.status, 'warn');
  assert.match(keptCheck.value, /kept by uninstall: .*(changed)/);
  const record = JSON.parse(await fs.readFile(installRecordPath(host), 'utf8'));
  const owner = record.owners[normalizeRepoPath(host.root)];
  owner.fingerprints.claude[item.relativeToHost] = await fileFingerprint(item.target);
  await fs.writeFile(installRecordPath(host), `${JSON.stringify(record, null, 2)}
`);
  const recorded = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const recordedCheck = recorded.checks.find((entry) => entry.key === 'host files');
  assert.equal(recordedCheck.status, 'ok');
});
