/** Verifies lossless, idempotent named hook settings updates and backups. */
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

function spec(target, event = 'SubagentStop', matcher = '*', hookPath = target.guardPath) {
  return { event, matcher, command: `node "${path.resolve(hookPath)}"` };
}

test('merge preserves a foreign hook, backs up settings, and remove deletes only our hook', async (t) => {
  const target = await fixture(t);
  const original = `${JSON.stringify({
    theme: 'dark',
    hooks: { SubagentStop: [{ matcher: '*', hooks: [{ type: 'command', command: 'dacapo hook claude' }] }] },
  }, null, 2)}\n`;
  await fs.writeFile(target.settingsPath, original);

  const merged = await mergeHook(target.settingsPath, spec(target));
  assert.deepEqual(merged, { changed: true, createdGroup: false });
  assert.equal((await backups(target.root)).length, 1);
  const backup = path.join(target.root, (await backups(target.root))[0]);
  assert.equal(await fs.readFile(backup, 'utf8'), original);
  const afterMerge = JSON.parse(await fs.readFile(target.settingsPath, 'utf8'));
  assert.equal(afterMerge.theme, 'dark');
  assert.equal(afterMerge.hooks.SubagentStop[0].hooks.length, 2);

  assert.deepEqual(await mergeHook(target.settingsPath, spec(target)), { changed: false, createdGroup: false });
  assert.equal((await backups(target.root)).length, 1);
  await removeHook(target.settingsPath, spec(target));
  const afterRemove = JSON.parse(await fs.readFile(target.settingsPath, 'utf8'));
  assert.deepEqual(afterRemove.hooks.SubagentStop[0].hooks, [{ type: 'command', command: 'dacapo hook claude' }]);
});

test('merge creates missing structures and removes a group that it created', async (t) => {
  for (const initial of [null, { model: 'test' }]) {
    const target = await fixture(t);
    if (initial) await fs.writeFile(target.settingsPath, JSON.stringify(initial));
    const result = await mergeHook(target.settingsPath, spec(target));
    assert.equal(result.createdGroup, true);
    const state = await inspectHook(target.settingsPath, spec(target));
    assert.equal(state.present, true);
    assert.deepEqual(state.settings.hooks.SubagentStop[0], {
      matcher: '*',
      hooks: [{ type: 'command', command: `node "${path.resolve(target.guardPath)}"`, timeout: 10 }],
    });
    await removeHook(target.settingsPath, spec(target), { createdGroup: true });
    const removed = JSON.parse(await fs.readFile(target.settingsPath, 'utf8'));
    assert.deepEqual(removed.hooks.SubagentStop, []);
  }
});

test('invalid JSON fails without changing settings or creating a backup', async (t) => {
  const target = await fixture(t);
  const invalid = '{ nope';
  await fs.writeFile(target.settingsPath, invalid);
  await assert.rejects(() => mergeHook(target.settingsPath, spec(target)), /cannot parse/);
  assert.equal(await fs.readFile(target.settingsPath, 'utf8'), invalid);
  assert.deepEqual(await backups(target.root), []);
});

test('named matcher operations leave a foreign matcher in the same event untouched', async (t) => {
  const target = await fixture(t);
  await fs.writeFile(target.settingsPath, JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'foreign pre-tool hook' }] }],
    },
  }));
  const gate = spec(target, 'PreToolUse', 'Agent', path.join(target.root, 'agents', 'codex', 'hooks', 'order-gate.mjs'));
  const merged = await mergeHook(target.settingsPath, gate);
  assert.deepEqual(merged, { changed: true, createdGroup: true });
  await removeHook(target.settingsPath, gate, { createdGroup: true });
  const settings = JSON.parse(await fs.readFile(target.settingsPath, 'utf8'));
  assert.deepEqual(settings.hooks.PreToolUse, [
    { matcher: '*' , hooks: [{ type: 'command', command: 'foreign pre-tool hook' }] },
  ]);
});

test('same-event hook removal follows the owned command when the matcher lookup is stale', async (t) => {
  const target = await fixture(t);
  const gate = spec(target, 'PreToolUse', 'Agent', path.join(target.root, 'agents', 'codex', 'hooks', 'order-gate.mjs'));
  const lock = spec(target, 'PreToolUse', 'Write', path.join(target.root, 'agents', 'codex', 'hooks', 'worktree-lock.mjs'));
  await mergeHook(target.settingsPath, gate);
  await mergeHook(target.settingsPath, lock);

  const staleLookup = { ...lock, matcher: gate.matcher };
  assert.equal((await inspectHook(target.settingsPath, staleLookup)).present, true);
  await removeHook(target.settingsPath, staleLookup, { createdGroup: true });
  const settings = JSON.parse(await fs.readFile(target.settingsPath, 'utf8'));
  assert.deepEqual(settings.hooks.PreToolUse, [{
    matcher: gate.matcher,
    hooks: [{ type: 'command', command: gate.command, timeout: 10 }],
  }]);
});

test('merge moves an outdated matcher registration and removes the emptied group', async (t) => {
  const target = await fixture(t);
  const lock = spec(target, 'PreToolUse', 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell',
    path.join(target.root, 'agents', 'codex', 'hooks', 'worktree-lock.mjs'));
  await fs.writeFile(target.settingsPath, JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: lock.command, timeout: 10 }],
      }],
    },
  }));

  assert.deepEqual(await mergeHook(target.settingsPath, lock), {
    changed: true,
    createdGroup: true,
    moved: true,
  });
  const settings = JSON.parse(await fs.readFile(target.settingsPath, 'utf8'));
  assert.deepEqual(settings.hooks.PreToolUse, [{
    matcher: lock.matcher,
    hooks: [{ type: 'command', command: lock.command, timeout: 10 }],
  }]);
  assert.equal(settings.hooks.PreToolUse.flatMap((group) => group.hooks)
    .filter((hook) => hook.command === lock.command).length, 1);
});

test('matcher move leaves a foreign hook in the old group untouched', async (t) => {
  const target = await fixture(t);
  const oldMatcher = 'Write|Edit|MultiEdit|NotebookEdit';
  const lock = spec(target, 'PreToolUse', `${oldMatcher}|Bash|PowerShell`,
    path.join(target.root, 'agents', 'codex', 'hooks', 'worktree-lock.mjs'));
  const foreign = { type: 'command', command: 'foreign worktree hook', timeout: 27 };
  await fs.writeFile(target.settingsPath, JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: oldMatcher,
        hooks: [foreign, { type: 'command', command: lock.command, timeout: 10 }],
      }],
    },
  }));

  await mergeHook(target.settingsPath, lock);
  const settings = JSON.parse(await fs.readFile(target.settingsPath, 'utf8'));
  assert.deepEqual(settings.hooks.PreToolUse, [
    { matcher: oldMatcher, hooks: [foreign] },
    { matcher: lock.matcher, hooks: [{ type: 'command', command: lock.command, timeout: 10 }] },
  ]);
});

test('merge does not rewrite or back up a registration already under the declared matcher', async (t) => {
  const target = await fixture(t);
  const lock = spec(target, 'PreToolUse', 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell',
    path.join(target.root, 'agents', 'codex', 'hooks', 'worktree-lock.mjs'));
  const original = `${JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: lock.matcher,
        hooks: [{ type: 'command', command: lock.command, timeout: 10 }],
      }],
    },
  }, null, 2)}\n`;
  await fs.writeFile(target.settingsPath, original);

  assert.deepEqual(await mergeHook(target.settingsPath, lock), { changed: false, createdGroup: false });
  assert.equal(await fs.readFile(target.settingsPath, 'utf8'), original);
  assert.deepEqual(await backups(target.root), []);
});

test('remove finds an owned registration under an outdated matcher', async (t) => {
  const target = await fixture(t);
  const lock = spec(target, 'PreToolUse', 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell',
    path.join(target.root, 'agents', 'codex', 'hooks', 'worktree-lock.mjs'));
  await fs.writeFile(target.settingsPath, JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: lock.command, timeout: 10 }],
      }],
    },
  }));

  assert.deepEqual(await removeHook(target.settingsPath, lock, { createdGroup: true }), { changed: true });
  const settings = JSON.parse(await fs.readFile(target.settingsPath, 'utf8'));
  assert.deepEqual(settings.hooks.PreToolUse, []);
});
