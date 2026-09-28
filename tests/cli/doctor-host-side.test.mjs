/** Verifies doctor host marks and shared-home owner reporting. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { diagnose } from '../../cli/doctor.mjs';
import { homeOwnersCheck, hostSideCheck } from '../../cli/doctor-host-side.mjs';
import { install } from '../../cli/install.mjs';
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
  assert.match(result.value, /inventory incomplete: an old record did not name every host/);
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
  assert.equal(result.value, `recorded: none; inventory incomplete: an old record did not name every host; ${host.root} has package files or hooks but is not recorded: run codex-bridge install --host "${host.root}"`);
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
