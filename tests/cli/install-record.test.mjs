/** Verifies installation-record normalization, persistence, and legacy lookup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import {
  INSTALL_RECORD_NAME,
  installRecordPath,
  legacyInstallRecordPath,
  normalizeInstallRecord,
  readInstallRecord,
  recordTarget,
  writeInstallRecord,
} from '../../cli/install-record.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-record-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
}

const files = [
  { root: 'claude', path: 'agents/codex-build.md' },
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
      claude: { 'agents/codex-build.md': 'a'.repeat(64) },
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
  assert.deepEqual(await readInstallRecord(host), normalizeInstallRecord(record()));
  assert.equal(recordTarget(host, files[0]), path.join(host.root, files[0].path));
  assert.equal(recordTarget(host, files[1]), path.join(host.brandRoot, files[1].path));
  await assert.rejects(() => fs.access(legacyInstallRecordPath(host)), { code: 'ENOENT' });
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

test('record validation refuses codex-runs entries before any migration can remove them', async () => {
  assert.throws(() => normalizeInstallRecord(record({
    files: [...files, { root: 'brand', path: 'codex-runs/run.json' }],
  })), /must not name run artifacts/);
});
