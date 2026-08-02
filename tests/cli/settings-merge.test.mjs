/** Verifies lossless, idempotent SubagentStop hook settings updates and backups. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectHook, mergeHook, removeHook } from '../../cli/settings-merge.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-settings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    settingsPath: path.join(root, 'settings.json'),
    guardPath: path.join(root, 'agents', 'codex', 'hooks', 'reply-guard.mjs'),
  };
}

async function backups(root) {
  return (await fs.readdir(root)).filter((name) => name.startsWith('settings.json.codex-bridge-backup-'));
}

test('merge preserves a foreign hook, backs up settings, and remove deletes only our hook', async (t) => {
  const target = await fixture(t);
  const original = `${JSON.stringify({
    theme: 'dark',
    hooks: { SubagentStop: [{ matcher: '*', hooks: [{ type: 'command', command: 'dacapo hook claude' }] }] },
  }, null, 2)}\n`;
  await fs.writeFile(target.settingsPath, original);

  const merged = await mergeHook(target.settingsPath, target.guardPath);
  assert.deepEqual(merged, { changed: true, createdGroup: false });
  assert.equal((await backups(target.root)).length, 1);
  const backup = path.join(target.root, (await backups(target.root))[0]);
  assert.equal(await fs.readFile(backup, 'utf8'), original);
  const afterMerge = JSON.parse(await fs.readFile(target.settingsPath, 'utf8'));
  assert.equal(afterMerge.theme, 'dark');
  assert.equal(afterMerge.hooks.SubagentStop[0].hooks.length, 2);

  assert.deepEqual(await mergeHook(target.settingsPath, target.guardPath), { changed: false, createdGroup: false });
  assert.equal((await backups(target.root)).length, 1);
  await removeHook(target.settingsPath, target.guardPath);
  const afterRemove = JSON.parse(await fs.readFile(target.settingsPath, 'utf8'));
  assert.deepEqual(afterRemove.hooks.SubagentStop[0].hooks, [{ type: 'command', command: 'dacapo hook claude' }]);
});

test('merge creates missing structures and removes a group that it created', async (t) => {
  for (const initial of [null, { model: 'test' }]) {
    const target = await fixture(t);
    if (initial) await fs.writeFile(target.settingsPath, JSON.stringify(initial));
    const result = await mergeHook(target.settingsPath, target.guardPath);
    assert.equal(result.createdGroup, true);
    const state = await inspectHook(target.settingsPath, target.guardPath);
    assert.equal(state.present, true);
    assert.deepEqual(state.settings.hooks.SubagentStop[0], {
      matcher: '*',
      hooks: [{ type: 'command', command: `node "${path.resolve(target.guardPath)}"`, timeout: 10 }],
    });
    await removeHook(target.settingsPath, target.guardPath, { createdGroup: true });
    const removed = JSON.parse(await fs.readFile(target.settingsPath, 'utf8'));
    assert.deepEqual(removed.hooks.SubagentStop, []);
  }
});

test('invalid JSON fails without changing settings or creating a backup', async (t) => {
  const target = await fixture(t);
  const invalid = '{ nope';
  await fs.writeFile(target.settingsPath, invalid);
  await assert.rejects(() => mergeHook(target.settingsPath, target.guardPath), /cannot parse/);
  assert.equal(await fs.readFile(target.settingsPath, 'utf8'), invalid);
  assert.deepEqual(await backups(target.root), []);
});
