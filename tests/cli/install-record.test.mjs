/** Verifies installation-record normalization, persistence, and legacy lookup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import {
  INSTALL_RECORD_NAME,
  installRecordPath,
  legacyInstallRecordPath,
  normalizeInstallRecord,
  readInstallRecord,
  removeInstallOwner,
  readInstallRecordFile,
  recordTarget,
  writeInstallRecord,
} from '../../cli/install-record.mjs';

async function fixture(t) {
  const root = makeTempTree('bridge-record-');
  t.after(() => removeTempTree(root));
  return resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
}

const files = [
  { root: 'claude', path: 'agents/codex-bridge/codex-build.md' },
  { root: 'brand', path: 'hooks/reply-guard.mjs' },
  { root: 'brand', path: 'lib/runner.mjs' },
];

function record(overrides = {}) {
  return {
    name: '@lyupro/codex-bridge',
    version: '0.1.0',
    installedAt: '2026-08-10T20:00:00.000Z',
    mode: 'copy',
    files,
    fingerprints: {
      claude: { 'agents/codex-bridge/codex-build.md': 'a'.repeat(64) },
      brand: {
        'hooks/reply-guard.mjs': 'b'.repeat(64),
        'lib/runner.mjs': 'c'.repeat(64),
      },
    },
    hooks: [{
      event: 'SubagentStop',
      root: 'brand',
      path: 'hooks/reply-guard.mjs',
      command: 'codex-bridge hook reply-guard',
      form: 'short',
    }],
    ...overrides,
  };
}

test('write and read keep both installation roots and nested fingerprints', async (t) => {
  const host = await fixture(t);
  await writeInstallRecord(host, record());

  assert.equal(installRecordPath(host), path.join(host.brandRoot, INSTALL_RECORD_NAME));
  await fs.access(installRecordPath(host));
  const expected = normalizeInstallRecord(record());
  expected.files = [
    ...expected.files.filter((file) => file.root === 'brand'),
    ...expected.files.filter((file) => file.root === 'claude'),
  ];
  assert.deepEqual(await readInstallRecord(host), expected);
  assert.equal(recordTarget(host, files[0]), path.join(host.root, files[0].path));
  assert.equal(recordTarget(host, files[1]), path.join(host.brandRoot, files[1].path));
  await assert.rejects(() => fs.access(legacyInstallRecordPath(host)), { code: 'ENOENT' });
});

test('write refuses an undeclared install record path before creating it', async (t) => {
  const host = await fixture(t);
  const target = path.join(host.brandRoot, 'not-declared', 'missing-record.json');
  await assert.rejects(
    () => writeInstallRecord({ ...host, brandInstallRecordPath: target }, record()),
    { code: 'EHOMEREGISTRY' },
  );
  await assert.rejects(() => fs.access(path.dirname(target)), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(target), { code: 'ENOENT' });
});

test('read migrates an old single-root record and singular hook to normalized entries', async (t) => {
  const host = await fixture(t);
  const legacyFiles = [
    'agents/codex/run-codex.mjs',
    'agents/codex/run-config.json',
    'agents/codex/conventions.md',
    'agents/codex/hooks/reply-guard.mjs',
  ];
  await fs.mkdir(path.dirname(legacyInstallRecordPath(host)), { recursive: true });
  await fs.writeFile(legacyInstallRecordPath(host), `${JSON.stringify({
    name: '@lyupro/codex-bridge',
    version: '0.0.9',
    installedAt: '2026-08-01T20:00:00.000Z',
    mode: 'copy',
    files: legacyFiles,
    hook: { event: 'SubagentStop', path: 'agents/codex/hooks/reply-guard.mjs' },
  }, null, 2)}\n`);

  const migrated = await readInstallRecord(host);

  assert.deepEqual(migrated.files, [
    { root: 'claude', path: 'agents/codex/run-codex.mjs' },
    { root: 'claude', path: 'agents/codex/hooks/reply-guard.mjs' },
  ]);
  assert.deepEqual(migrated.hooks, [{
    event: 'SubagentStop',
    path: 'agents/codex/hooks/reply-guard.mjs',
    root: 'claude',
  }]);
  assert.equal(migrated.fingerprints, undefined);
  const fallback = await readInstallRecord({
    ...host,
    brandInstallRecordPath: path.join(host.brandRoot, 'missing-record.json'),
  });
  assert.equal(fallback.version, '0.0.9');
});

function hostRecord(label) {
  const ownerPath = 'agents/' + label + '/reply-guard.mjs';
  const base = record();
  return record({
    files: [
      { root: 'claude', path: ownerPath },
      ...base.files.filter((file) => file.root === 'brand'),
    ],
    fingerprints: {
      claude: { [ownerPath]: 'd'.repeat(64) },
      brand: base.fingerprints.brand,
    },
    hooks: [{
      event: 'SubagentStop',
      root: 'claude',
      path: ownerPath,
      command: 'codex-bridge hook reply-guard',
    }],
  });
}

test('two Claude hosts sharing one brand home retain their own record views', async (t) => {
  const root = makeTempTree('bridge-shared-record-');
  t.after(() => removeTempTree(root));
  const brandRoot = path.join(root, 'brand');
  const first = resolveHost({
    host: path.join(root, 'host-a'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot,
  });
  const second = resolveHost({
    host: path.join(root, 'host-b'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot,
  });

  await writeInstallRecord(first, hostRecord('host-a'));
  await writeInstallRecord(second, hostRecord('host-b'));

  const stored = await readInstallRecordFile(first);
  assert.equal(stored.format, 2);
  assert.equal(Object.keys(stored.owners).length, 2);
  const firstView = await readInstallRecord(first);
  const secondView = await readInstallRecord(second);
  assert.deepEqual(firstView.hooks, hostRecord('host-a').hooks);
  assert.deepEqual(secondView.hooks, hostRecord('host-b').hooks);
  assert.equal(firstView.files.at(-1).path, 'agents/host-a/reply-guard.mjs');
  assert.equal(secondView.files.at(-1).path, 'agents/host-b/reply-guard.mjs');
  assert.deepEqual(firstView.files.map((file) => file.root), ['brand', 'brand', 'claude']);
  assert.deepEqual(secondView.files.map((file) => file.root), ['brand', 'brand', 'claude']);
  assert.deepEqual((await fs.readdir(brandRoot)).filter((name) => name.endsWith('.tmp')), []);
});

test('a fresh image inventory stays complete as another host joins', async (t) => {
  const root = makeTempTree('bridge-fresh-shared-record-');
  t.after(() => removeTempTree(root));
  const brandRoot = path.join(root, 'brand');
  const first = resolveHost({ host: path.join(root, 'host-a'), brandRoot });
  const second = resolveHost({ host: path.join(root, 'host-b'), brandRoot });

  await writeInstallRecord(first, hostRecord('host-a'), { homeHadImage: false });
  assert.equal((await readInstallRecordFile(first)).inventory, 'complete');
  await fs.mkdir(path.join(brandRoot, 'lib'), { recursive: true });
  await writeInstallRecord(second, hostRecord('host-b'));

  const stored = await readInstallRecordFile(first);
  assert.equal(stored.inventory, 'complete');
  assert.equal(Object.keys(stored.owners).length, 2);
});

test('a pre-existing image without a record starts with incomplete inventory', async (t) => {
  const host = await fixture(t);
  await fs.mkdir(path.join(host.brandRoot, 'lib'), { recursive: true });
  await writeInstallRecord(host, hostRecord('existing-image'), { homeHadImage: true });

  assert.equal((await readInstallRecordFile(host)).inventory, 'incomplete');
});

test('a complete transition answer publishes without the migrated legacy record', async (t) => {
  const host = await fixture(t);
  const legacy = record();
  await fs.mkdir(path.dirname(installRecordPath(host)), { recursive: true });
  await fs.writeFile(installRecordPath(host), JSON.stringify(legacy, null, 2) + '\n');

  await writeInstallRecord(host, record({ version: '0.2.0' }), { inventory: 'complete' });

  const stored = await readInstallRecordFile(host);
  assert.equal(stored.inventory, 'complete');
  assert.equal(Object.hasOwn(stored, 'legacy'), false);
});

test('format-1 migration without a complete answer keeps its legacy record and incomplete inventory', async (t) => {
  const host = await fixture(t);
  const legacy = record();
  await fs.mkdir(path.dirname(installRecordPath(host)), { recursive: true });
  await fs.writeFile(installRecordPath(host), JSON.stringify(legacy, null, 2) + '\n');

  await writeInstallRecord(host, record({ version: '0.2.0' }));

  const stored = await readInstallRecordFile(host);
  assert.equal(stored.inventory, 'incomplete');
  assert.deepEqual(stored.legacy, normalizeInstallRecord(legacy));
});

test('removeInstallOwner preserves the other host view and publishes without a temp file', async (t) => {
  const root = makeTempTree('bridge-remove-owner-');
  t.after(() => removeTempTree(root));
  const brandRoot = path.join(root, 'brand');
  const first = resolveHost({ host: path.join(root, 'host-a'), brandRoot });
  const second = resolveHost({ host: path.join(root, 'host-b'), brandRoot });

  await writeInstallRecord(first, hostRecord('host-a'), { homeHadImage: false });
  await writeInstallRecord(second, hostRecord('host-b'));

  const removed = await removeInstallOwner(first);
  assert.equal(Object.keys(removed.owners).length, 1);
  assert.equal(Object.values(removed.owners)[0].root, second.root);
  assert.equal(await readInstallRecord(first), null);
  assert.deepEqual((await readInstallRecord(second)).hooks, hostRecord('host-b').hooks);
  assert.deepEqual((await fs.readdir(brandRoot)).filter((name) => name.endsWith('.tmp')), []);
});
test('a format-1 record at the shared path is still read as a host view', async (t) => {
  const host = await fixture(t);
  const legacy = hostRecord('format-one');
  await fs.mkdir(path.dirname(installRecordPath(host)), { recursive: true });
  await fs.writeFile(installRecordPath(host), JSON.stringify(legacy, null, 2) + '\n');

  assert.deepEqual(await readInstallRecord(host), normalizeInstallRecord(legacy));
});

test('a format-2 non-owner can still read the migrated format-1 view', async (t) => {
  const root = makeTempTree('bridge-record-fallback-');
  t.after(() => removeTempTree(root));
  const brandRoot = path.join(root, 'brand');
  const first = resolveHost({ host: path.join(root, 'host-a'), brandRoot });
  const second = resolveHost({ host: path.join(root, 'host-b'), brandRoot });
  const legacy = hostRecord('legacy-owner');
  await fs.mkdir(path.dirname(installRecordPath(first)), { recursive: true });
  await fs.writeFile(installRecordPath(first), JSON.stringify(legacy, null, 2) + '\n');

  await writeInstallRecord(second, hostRecord('new-owner'));

  const legacyView = await readInstallRecord(first);
  assert.deepEqual(legacyView.hooks, legacy.hooks);
  assert.equal(legacyView.files.find((file) => file.root === 'claude').path, 'agents/legacy-owner/reply-guard.mjs');
});

test('an adapter refusal leaves the existing install record intact', async (t) => {
  const host = await fixture(t);
  await writeInstallRecord(host, record());
  const target = installRecordPath(host);
  const before = await fs.readFile(target, 'utf8');
  const wrongLayout = {
    ...host,
    brandInstallRecordPath: path.join(host.brandRoot, 'not-declared', 'record.json'),
  };

  await assert.rejects(() => writeInstallRecord(wrongLayout, record()), { code: 'EHOMEREGISTRY' });
  assert.equal(await fs.readFile(target, 'utf8'), before);
});

test('record validation refuses codex-runs entries before any migration can remove them', async () => {
  assert.throws(() => normalizeInstallRecord(record({
    files: [...files, { root: 'brand', path: 'codex-runs/run.json' }],
  })), /must not name run artifacts/);
});
