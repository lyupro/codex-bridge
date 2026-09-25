/** Verifies recorded and outside removals respect the package home artifact registry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { recordHomeWriter, removeOutside, removeRecordedFile } from '../../cli/record-removal.mjs';
import { makeTempTree } from '../temp-tree.mjs';

function fixture(prefix) {
  const root = makeTempTree(prefix);
  const host = {
    root: path.join(root, 'host'),
    brandRoot: path.join(root, 'brand'),
    agentsDir: path.join(root, 'host', 'agents'),
    commandsDir: path.join(root, 'host', 'commands'),
    legacyAgentsDir: path.join(root, 'host', 'legacy-agents'),
    legacyCommandsDir: path.join(root, 'host', 'legacy-commands'),
  };
  return { host };
}

async function seed(host, entry) {
  const target = path.join(entry.root === 'brand' ? host.brandRoot : host.root, entry.path);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'recorded');
  return target;
}

test('a recorded brand file is unlinked through the adapter and its empty parents are removed', async () => {
  const { host } = fixture('bridge-record-removal-brand-');
  const entry = { root: 'brand', path: 'agents/codex-bridge/agent.md' };
  const target = await seed(host, entry);
  const writer = recordHomeWriter(host, [entry]);

  await removeRecordedFile(host, writer, entry);

  await assert.rejects(fs.access(target), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.dirname(target)), { code: 'ENOENT' });
  await fs.access(host.brandRoot);
});

test('a brand file absent from the record is refused and left in place', async () => {
  const { host } = fixture('bridge-record-removal-unlisted-');
  const entry = { root: 'brand', path: 'agents/foreign.md' };
  const target = await seed(host, entry);
  const writer = recordHomeWriter(host, []);

  await assert.rejects(removeRecordedFile(host, writer, entry), { code: 'EHOMEREGISTRY' });
  assert.equal(await fs.readFile(target, 'utf8'), 'recorded');
});

test('a recorded host file is removed and its owned parent is cleaned up', async () => {
  const { host } = fixture('bridge-record-removal-host-');
  const entry = { root: 'host', path: 'agents/codex-bridge/agent.md' };
  const target = await seed(host, entry);
  const writer = recordHomeWriter(host, [entry]);

  await removeRecordedFile(host, writer, entry);

  await assert.rejects(fs.access(target), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.dirname(target)), { code: 'ENOENT' });
  await fs.access(host.agentsDir);
});

test('outside removal refuses a target inside the package home', async () => {
  const { host } = fixture('bridge-record-removal-outside-');
  const target = path.join(host.brandRoot, 'config.json');
  await fs.mkdir(host.brandRoot, { recursive: true });
  await fs.writeFile(target, 'keep');
  const writer = recordHomeWriter(host, []);

  await assert.rejects(removeOutside(writer, target), { code: 'EHOMEREGISTRY' });
  assert.equal(await fs.readFile(target, 'utf8'), 'keep');
});

test('a missing recorded file is not an error', async () => {
  const { host } = fixture('bridge-record-removal-missing-');
  const entry = { root: 'brand', path: 'agents/missing.md' };
  const writer = recordHomeWriter(host, [entry]);

  await removeRecordedFile(host, writer, entry);
});
