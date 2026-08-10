/** Verifies the boundary and the emptied-directory walk shared by uninstall and update. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import {
  claudeBoundary,
  removeEmpty,
  removeEmptyLayout,
  removeEmptyParents,
} from '../../cli/remove-layout.mjs';

const hostFor = (homedir) => resolveHost({ homedir });

async function tempHome(t) {
  const homedir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-remove-'));
  t.after(() => fs.rm(homedir, { recursive: true, force: true }));
  return homedir;
}

test('a target inside a package directory stops the walk at that directory', () => {
  const host = hostFor(path.join(os.tmpdir(), 'bridge-boundary'));
  const nested = path.join(host.agentsDir, 'hooks', 'reply-guard.mjs');
  assert.equal(claudeBoundary(host, nested), host.agentsDir);
  assert.equal(claudeBoundary(host, path.join(host.commandsDir, 'env.md')), host.commandsDir);
});

test('the previous layout has its own boundary, not the current one', () => {
  const host = hostFor(path.join(os.tmpdir(), 'bridge-boundary-legacy'));
  assert.equal(claudeBoundary(host, path.join(host.legacyAgentsDir, 'run-codex.mjs')), host.legacyAgentsDir);
  assert.equal(claudeBoundary(host, path.join(host.legacyCommandsDir, 'usage.md')), host.legacyCommandsDir);
});

test('a target under no package directory falls back to the host root', () => {
  const host = hostFor(path.join(os.tmpdir(), 'bridge-boundary-foreign'));
  const foreign = path.join(host.root, 'agents', 'someone-else', 'agent.md');
  assert.equal(claudeBoundary(host, foreign), host.root);
});

test('a directory sharing a prefix with a package directory is not inside it', () => {
  const host = hostFor(path.join(os.tmpdir(), 'bridge-boundary-prefix'));
  // `agents/codex-bridge-extra` starts with the same characters as `agents/codex-bridge`; a
  // startsWith without the separator would claim it and walk the wrong tree up.
  assert.equal(claudeBoundary(host, `${host.agentsDir}-extra${path.sep}agent.md`), host.root);
});

test('removeEmpty leaves a directory that still holds a file', async (t) => {
  const homedir = await tempHome(t);
  const directory = path.join(homedir, 'kept');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'operator-notes.md'), 'mine\n');
  await removeEmpty(directory);
  await fs.access(directory);
});

test('removeEmpty on a missing directory is not an error', async (t) => {
  const homedir = await tempHome(t);
  await removeEmpty(path.join(homedir, 'never-existed'));
});

test('the walk stops at the boundary and never removes it', async (t) => {
  const homedir = await tempHome(t);
  const boundary = path.join(homedir, 'boundary');
  const leaf = path.join(boundary, 'one', 'two', 'file.mjs');
  await fs.mkdir(path.dirname(leaf), { recursive: true });
  await fs.writeFile(leaf, 'x\n');
  await fs.rm(leaf);
  await removeEmptyParents(leaf, boundary);
  await assert.rejects(() => fs.access(path.join(boundary, 'one')), { code: 'ENOENT' });
  await fs.access(boundary);
});

test('the walk stops as soon as a directory still holds something', async (t) => {
  const homedir = await tempHome(t);
  const boundary = path.join(homedir, 'boundary');
  const kept = path.join(boundary, 'one');
  const leaf = path.join(kept, 'two', 'file.mjs');
  await fs.mkdir(path.dirname(leaf), { recursive: true });
  await fs.writeFile(path.join(kept, 'operator-file.md'), 'mine\n');
  await removeEmptyParents(leaf, boundary);
  await assert.rejects(() => fs.access(path.join(kept, 'two')), { code: 'ENOENT' });
  await fs.access(path.join(kept, 'operator-file.md'));
});

test('removeEmptyLayout takes down the directory and what it leaves empty behind it', async (t) => {
  const homedir = await tempHome(t);
  const host = hostFor(homedir);
  await fs.mkdir(host.legacyAgentsDir, { recursive: true });
  await removeEmptyLayout(host.legacyAgentsDir, host.root);
  await assert.rejects(() => fs.access(host.legacyAgentsDir), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(path.join(host.root, 'agents')), { code: 'ENOENT' });
  await fs.access(host.root);
});

test('removeEmptyLayout keeps a previous-layout directory holding a foreign file', async (t) => {
  const homedir = await tempHome(t);
  const host = hostFor(homedir);
  const foreign = path.join(host.legacyCommandsDir, 'operator-command.md');
  await fs.mkdir(host.legacyCommandsDir, { recursive: true });
  await fs.writeFile(foreign, 'mine\n');
  await removeEmptyLayout(host.legacyCommandsDir, host.root);
  await fs.access(foreign);
});
