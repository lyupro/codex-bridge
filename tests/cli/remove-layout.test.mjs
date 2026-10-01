/** Verifies the boundary and the emptied-directory walk shared by uninstall and update. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { createHomeWriter } from '../../src/home/lib/home-write.mjs';
import {
  claudeBoundary,
  removeEmpty,
  removeEmptyHome,
  removeEmptyHomeParents,
  removeEmptyLayout,
  removeEmptyParents,
} from '../../cli/remove-layout.mjs';

const hostFor = (homedir) => resolveHost({ homedir });

async function tempHome(t) {
  const homedir = makeTempTree('bridge-remove-');
  t.after(() => removeTempTree(homedir));
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

test('removeEmptyLayout takes down the emptied package directory', async (t) => {
  const homedir = await tempHome(t);
  const host = hostFor(homedir);
  await fs.mkdir(host.legacyAgentsDir, { recursive: true });
  await removeEmptyLayout(host.legacyAgentsDir);
  await assert.rejects(() => fs.access(host.legacyAgentsDir), { code: 'ENOENT' });
});

test('the shared agents and commands directories survive their emptied package subdirectory', async (t) => {
  // Claude Code owns ~/.claude/agents and ~/.claude/commands and shares them with every other
  // agent the operator has. An operator whose only agents were ours would have had those two
  // directories deleted out from under Claude Code by an uninstall that walked up one level too
  // far, so this is asserted rather than left to the boundary argument.
  const homedir = await tempHome(t);
  const host = hostFor(homedir);
  await fs.mkdir(host.legacyAgentsDir, { recursive: true });
  await fs.mkdir(host.legacyCommandsDir, { recursive: true });
  await removeEmptyLayout(host.legacyAgentsDir);
  await removeEmptyLayout(host.legacyCommandsDir);
  await fs.access(path.join(host.root, 'agents'));
  await fs.access(path.join(host.root, 'commands'));
});

test('removeEmptyLayout keeps a previous-layout directory holding a foreign file', async (t) => {
  const homedir = await tempHome(t);
  const host = hostFor(homedir);
  const foreign = path.join(host.legacyCommandsDir, 'operator-command.md');
  await fs.mkdir(host.legacyCommandsDir, { recursive: true });
  await fs.writeFile(foreign, 'mine\n');
  await removeEmptyLayout(host.legacyCommandsDir);
  await fs.access(foreign);
});

test('home parent removal uses the adapter and keeps the home root', async (t) => {
  const tree = await tempHome(t);
  const root = path.join(tree, 'home');
  const writer = createHomeWriter({ root, imageMembers: ['lib/runner/a.mjs', 'lib/b.mjs'] });
  const target = path.join(root, 'lib', 'runner', 'a.mjs');
  writer.mkdirSync('install-image', path.dirname(target));
  writer.writeFileSync('install-image', target, 'image');
  await writer.unlink('install-image', target);
  const result = await removeEmptyHomeParents(writer, 'install-image', target, root);
  assert.deepEqual(result, { kept: null });
  assert.equal(fsSync.existsSync(path.dirname(target)), false);
  assert.equal(fsSync.existsSync(path.join(root, 'lib')), false);
  assert.equal(fsSync.existsSync(root), true);
});

test('home parent removal stops at a non-empty parent', async (t) => {
  const tree = await tempHome(t);
  const root = path.join(tree, 'home');
  const writer = createHomeWriter({ root, imageMembers: ['lib/runner/a.mjs', 'lib/b.mjs'] });
  const target = path.join(root, 'lib', 'runner', 'a.mjs');
  const kept = path.join(root, 'lib', 'b.mjs');
  writer.mkdirSync('install-image', path.dirname(target));
  writer.writeFileSync('install-image', kept, 'keep');
  const result = await removeEmptyHomeParents(writer, 'install-image', target, root);
  assert.deepEqual(result, { kept: null });
  assert.equal(fsSync.existsSync(path.dirname(target)), false);
  assert.equal(fsSync.existsSync(path.join(root, 'lib')), true);
  assert.equal(await fs.readFile(kept, 'utf8'), 'keep');
});

test('home parent removal keeps both an ancestor junction and its outside target', async (t) => {
  const tree = await tempHome(t);
  const root = path.join(tree, 'home');
  const outside = path.join(tree, 'outside');
  const link = path.join(root, 'lib');
  const writer = createHomeWriter({ root, imageMembers: ['lib/runner/a.mjs', 'lib/a.mjs'] });
  await fs.mkdir(root);
  await fs.mkdir(path.join(outside, 'runner'), { recursive: true });
  fsSync.symlinkSync(outside, link, 'junction');
  const result = await removeEmptyHomeParents(writer, 'install-image', path.join(link, 'runner', 'a.mjs'), root);
  assert.equal(result.kept.kind, 'link');
  assert.equal(result.kept.at, link);
  assert.equal(fsSync.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fsSync.existsSync(outside), true);
  assert.equal(fsSync.existsSync(path.join(outside, 'runner')), true);
  const direct = await removeEmptyHomeParents(writer, 'install-image', path.join(link, 'a.mjs'), root);
  assert.equal(direct.kept.kind, 'link');
  assert.equal(fsSync.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fsSync.existsSync(outside), true);
});

test('home parent removal continues upward past an already missing middle folder', async (t) => {
  const tree = await tempHome(t);
  const root = path.join(tree, 'home');
  const writer = createHomeWriter({ root, imageMembers: ['lib/runner/a.mjs', 'lib/b.mjs'] });
  const target = path.join(root, 'lib', 'runner', 'a.mjs');
  writer.mkdirSync('install-image', path.join(root, 'lib'));
  const result = await removeEmptyHomeParents(writer, 'install-image', target, root);
  assert.deepEqual(result, { kept: null });
  assert.equal(fsSync.existsSync(path.join(root, 'lib')), false);
  assert.equal(fsSync.existsSync(root), true);
});

test('home parent removal never enters a sibling sharing the root prefix', async (t) => {
  const tree = await tempHome(t);
  const root = path.join(tree, 'home');
  const writer = createHomeWriter({ root, imageMembers: ['lib/runner/a.mjs', 'lib/b.mjs'] });
  const sibling = path.join(tree, 'home-extra', 'lib', 'runner');
  await fs.mkdir(sibling, { recursive: true });
  const result = await removeEmptyHomeParents(writer, 'install-image', path.join(sibling, 'a.mjs'), root);
  assert.deepEqual(result, { kept: null });
  assert.equal(fsSync.existsSync(sibling), true);
});

test('home parent removal propagates a real readdir error without removing anything', async (t) => {
  const tree = await tempHome(t);
  const root = path.join(tree, 'home');
  const writer = createHomeWriter({ root, imageMembers: ['lib/runner/a.mjs', 'lib/b.mjs'] });
  await fs.mkdir(root);
  const blocked = path.join(root, 'lib');
  await fs.writeFile(blocked, 'not a directory');
  const target = path.join(blocked, 'a.mjs');
  await assert.rejects(() => removeEmptyHomeParents(writer, 'install-image', target, root), { code: 'ENOTDIR' });
  assert.equal(await fs.readFile(blocked, 'utf8'), 'not a directory');
});

test('removeEmptyHome removes an empty trusted root through the adapter', async (t) => {
  const tree = await tempHome(t);
  const root = path.join(tree, 'home');
  const writer = createHomeWriter({ root, imageMembers: ['lib/runner/a.mjs', 'lib/b.mjs'] });
  writer.mkdirSync('install-image', root);
  await removeEmptyHome(writer, 'install-image', root);
  assert.equal(fsSync.existsSync(root), false);
});

test('removeEmptyHome keeps a non-empty root', async (t) => {
  const tree = await tempHome(t);
  const root = path.join(tree, 'home');
  const writer = createHomeWriter({ root, imageMembers: ['lib/runner/a.mjs', 'lib/b.mjs'] });
  writer.mkdirSync('install-image', path.join(root, 'lib', 'runner'));
  await removeEmptyHome(writer, 'install-image', root);
  assert.equal(fsSync.existsSync(root), true);
  assert.equal(fsSync.existsSync(path.join(root, 'lib', 'runner')), true);
});

test('removeEmptyHome ignores a missing root', async (t) => {
  const tree = await tempHome(t);
  const root = path.join(tree, 'home');
  const writer = createHomeWriter({ root, imageMembers: ['lib/runner/a.mjs', 'lib/b.mjs'] });
  await removeEmptyHome(writer, 'install-image', root);
  assert.equal(fsSync.existsSync(root), false);
});
