/** Verifies that operator-owned seeded files survive install, update and uninstall. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { update } from '../../cli/update.mjs';
import { installRecordPath, readInstallRecord, seedPlan } from '../../cli/manifest.mjs';

async function fixture(t) {
  const root = makeTempTree('bridge-seed-');
  t.after(() => removeTempTree(root));
  return resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
}

const CONFIGURED = '{\n  "hooks": false,\n  "plugins": false,\n  "models": {"build": {"model": "m", "effort": "max"}}\n}\n';

test('a seeded file from the previous layout moves rather than being copied', async (t) => {
  // Copying and leaving the original behind kept agents/codex non-empty forever, so the previous
  // layout was never taken down and the operator went on editing a file nothing reads.
  const host = await fixture(t);
  const legacy = path.join(host.legacyAgentsDir, 'run-config.json');
  await fs.mkdir(host.legacyAgentsDir, { recursive: true });
  await fs.writeFile(legacy, CONFIGURED);
  await install({ host });
  const [seed] = seedPlan(host);
  assert.equal(await fs.readFile(seed.target, 'utf8'), CONFIGURED);
  await assert.rejects(() => fs.access(legacy), { code: 'ENOENT' });
});

test('the previous layout keeps conventions.md decisions through the move', async (t) => {
  const host = await fixture(t);
  const legacy = path.join(host.legacyAgentsDir, 'conventions.md');
  await fs.mkdir(host.legacyAgentsDir, { recursive: true });
  await fs.writeFile(legacy, '## Conventions\n\nnever push\n');
  await install({ host });
  assert.equal(await fs.readFile(host.brandConventionsPath, 'utf8'), '## Conventions\n\nnever push\n');
  await assert.rejects(() => fs.access(legacy), { code: 'ENOENT' });
});

test('install seeds the config once and never records it as a package file', async (t) => {
  const host = await fixture(t);
  await install({ host });
  const [seed] = seedPlan(host);
  assert.equal(path.basename(seed.target), 'config.json');
  assert.ok(await fs.readFile(seed.target, 'utf8'));
  const record = await readInstallRecord(host);
  const relative = path.relative(host.brandRoot, seed.target).split(path.sep).join('/');
  assert.equal(record.files.some((file) => file.root === 'brand' && file.path === relative), false);
});

test('a configured host keeps its config through install --force', async (t) => {
  const host = await fixture(t);
  await install({ host });
  const [seed] = seedPlan(host);
  await fs.writeFile(seed.target, CONFIGURED);
  await install({ host, force: true });
  assert.equal(await fs.readFile(seed.target, 'utf8'), CONFIGURED);
});

test('update neither rewrites the config nor stops because of it', async (t) => {
  const host = await fixture(t);
  await install({ host });
  const [seed] = seedPlan(host);
  await fs.writeFile(seed.target, CONFIGURED);
  const result = await update({ host });
  assert.equal(result.exitCode, 0);
  assert.equal(await fs.readFile(seed.target, 'utf8'), CONFIGURED);
});

test('a record from before seeding does not make update delete the config', async (t) => {
  const host = await fixture(t);
  await install({ host });
  const [seed] = seedPlan(host);
  await fs.writeFile(seed.target, CONFIGURED);
  const recordPath = installRecordPath(host);
  const legacy = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  const relative = path.relative(host.brandRoot, seed.target).split(path.sep).join('/');
  legacy.files.push({ root: 'brand', path: relative });
  legacy.fingerprints.brand[relative] = 'a'.repeat(64);
  await fs.writeFile(recordPath, `${JSON.stringify(legacy, null, 2)}\n`);
  const result = await update({ host, force: true });
  assert.equal(result.exitCode, 0);
  assert.equal(await fs.readFile(seed.target, 'utf8'), CONFIGURED);
});

test('uninstall leaves the config behind with the run artifacts', async (t) => {
  const host = await fixture(t);
  await install({ host });
  const [seed] = seedPlan(host);
  await fs.writeFile(seed.target, CONFIGURED);
  await uninstall({ host });
  assert.equal(await fs.readFile(seed.target, 'utf8'), CONFIGURED);
});
