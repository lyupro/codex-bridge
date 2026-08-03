/** Verifies that operator-owned seeded files survive install, update and uninstall. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { update } from '../../cli/update.mjs';
import { readInstallRecord, seedPlan } from '../../cli/manifest.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-seed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return resolveHost({ host: path.join(root, 'host'), codexHome: path.join(root, 'codex-home') });
}

const CONFIGURED = '{\n  "hooks": false,\n  "plugins": false,\n  "models": {"build": {"model": "m", "effort": "max"}}\n}\n';

test('install seeds the config once and never records it as a package file', async (t) => {
  const host = await fixture(t);
  await install({ host });
  const [seed] = seedPlan(host);
  assert.equal(path.basename(seed.target), 'run-config.json');
  assert.ok(await fs.readFile(seed.target, 'utf8'));
  const record = await readInstallRecord(host);
  const relative = path.relative(host.root, seed.target).split(path.sep).join('/');
  assert.equal(record.files.includes(relative), false);
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
  const recordPath = path.join(host.agentsDir, '.codex-bridge-install.json');
  const legacy = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  const relative = path.relative(host.root, seed.target).split(path.sep).join('/');
  legacy.files.push(relative);
  legacy.fingerprints[relative] = 'a'.repeat(64);
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
