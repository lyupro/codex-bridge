/** Verifies shared rules ownership survives concurrent registry updates. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  addRulesOwner,
  normalizedRulesOwner,
  readRulesRegistry,
} from '../../cli/rules-owners.mjs';

test('concurrent owner registrations retain every owner', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-rules-owners-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codexRulesDir = path.join(root, 'codex-home', 'rules');
  const hosts = ['first-host', 'second-host'].map((name) => ({
    root: path.join(root, name),
    codexRulesDir,
  }));

  await Promise.all(hosts.map((host) => addRulesOwner(host)));

  const registry = await readRulesRegistry(hosts[0]);
  assert.equal(registry.owners.length, hosts.length);
  for (const host of hosts) assert.ok(registry.owners.includes(normalizedRulesOwner(host)));
});

test('a lock left behind by a dead process does not block the next owner', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-rules-stale-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codexRulesDir = path.join(root, 'codex-home', 'rules');
  const host = { root: path.join(root, 'host'), codexRulesDir };

  const lockPath = path.join(codexRulesDir, '.codex-bridge-rules.json.lock');
  await fs.mkdir(codexRulesDir, { recursive: true });
  await fs.writeFile(lockPath, '');
  const longAgo = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, longAgo, longAgo);

  const registry = await addRulesOwner(host);

  assert.deepEqual(registry.owners, [normalizedRulesOwner(host)]);
  await assert.rejects(() => fs.stat(lockPath), { code: 'ENOENT' });
});

test('a lock a live process is holding is waited for, not stolen', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-rules-live-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codexRulesDir = path.join(root, 'codex-home', 'rules');
  const host = { root: path.join(root, 'host'), codexRulesDir };

  const lockPath = path.join(codexRulesDir, '.codex-bridge-rules.json.lock');
  await fs.mkdir(codexRulesDir, { recursive: true });
  await fs.writeFile(lockPath, '');

  // 200 retries at 5 ms give the holder a full second; release well inside that window.
  const release = setTimeout(() => fs.rm(lockPath, { force: true }), 60);
  t.after(() => clearTimeout(release));
  const registry = await addRulesOwner(host);

  assert.deepEqual(registry.owners, [normalizedRulesOwner(host)]);
});
