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
