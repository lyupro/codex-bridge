import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree, withTempTree } from './temp-tree.mjs';
import {
  dispatcherStatePath,
  pruneDispatcherStates,
  readDispatcherState,
  updateDispatcherState,
} from '../src/home/lib/dispatcher-state.mjs';

test('dispatcher paths hash both ids and never use ids as path segments', () => {
  const stateDir = path.join('test-home', 'state');
  const sessionId = 'session/..\\foreign';
  const agentId = 'agent\\../name';
  const digest = createHash('sha256').update(`${sessionId}\n${agentId}`).digest('hex').slice(0, 32);
  const file = dispatcherStatePath({ stateDir, sessionId, agentId });
  assert.equal(file, path.join(stateDir, 'dispatchers', `${digest}.json`));
  assert.equal(path.dirname(file), path.join(stateDir, 'dispatchers'));
  assert.throws(() => dispatcherStatePath({ stateDir, sessionId: '', agentId }), TypeError);
  assert.throws(() => dispatcherStatePath({ stateDir, sessionId, agentId: null }), TypeError);
});

test('dispatcher state round trips an identity-bound record and returns null when absent', async () => {
  await withTempTree('dispatcher-state-', async (tree) => {
    const stateDir = path.join(tree, 'state');
    const ids = { stateDir, sessionId: 'session-a', agentId: 'agent-a', now: new Date('2026-09-24T10:00:00Z') };
    assert.equal(readDispatcherState(ids), null);
    const written = await updateDispatcherState(ids, (current) => ({ ...current, stdout: 'last output' }));
    assert.deepEqual(readDispatcherState(ids), written);
    assert.equal(written.createdAt, '2026-09-24T10:00:00.000Z');
    assert.equal(written.updatedAt, '2026-09-24T10:00:00.000Z');
  });
});

test('dispatcher state rejects a record whose stored identity differs from the requested ids', async () => {
  await withTempTree('dispatcher-state-identity-', async (tree) => {
    const stateDir = path.join(tree, 'state');
    const ids = { stateDir, sessionId: 'session-b', agentId: 'agent-b' };
    const file = dispatcherStatePath(ids);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessionId: 'someone-else', agentId: ids.agentId }));
    assert.deepEqual(readDispatcherState(ids), { corrupt: true });
  });
});

test('dispatcher state reports invalid JSON as corrupt and passes corruption to the mutator', async () => {
  await withTempTree('dispatcher-state-corrupt-', async (tree) => {
    const stateDir = path.join(tree, 'state');
    const ids = { stateDir, sessionId: 'session-c', agentId: 'agent-c' };
    const file = dispatcherStatePath(ids);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(readDispatcherState(ids), { corrupt: true });
    const written = await updateDispatcherState(ids, (current) => {
      assert.deepEqual(current, { corrupt: true });
      return { recovered: true };
    });
    assert.equal(written.recovered, true);
    assert.equal(readDispatcherState(ids).sessionId, ids.sessionId);
  });
});

test('concurrent dispatcher updates serialize through the shared file lock', async () => {
  await withTempTree('dispatcher-state-concurrent-', async (tree) => {
    const stateDir = path.join(tree, 'state');
    const ids = { stateDir, sessionId: 'session-d', agentId: 'agent-d' };
    await Promise.all(Array.from({ length: 10 }, () => updateDispatcherState(ids, (current) => ({
      ...current,
      counter: (current.counter ?? 0) + 1,
    }))));
    assert.equal(readDispatcherState(ids).counter, 10);
  });
});

test('pruning removes only expired dispatcher records and their locks', () => {
  const stateDir = path.join(makeTempTree('dispatcher-state-prune-'), 'state');
  const dispatchersDir = path.join(stateDir, 'dispatchers');
  fs.mkdirSync(dispatchersDir, { recursive: true });
  const oldFile = path.join(dispatchersDir, `${'a'.repeat(32)}.json`);
  const recentFile = path.join(dispatchersDir, `${'b'.repeat(32)}.json`);
  const foreignFile = path.join(dispatchersDir, 'old.json');
  const outsideFile = path.join(stateDir, 'outside.json');
  for (const file of [oldFile, recentFile, foreignFile, outsideFile, `${oldFile}.lock`]) fs.writeFileSync(file, '{}');
  const now = 2_000_000;
  const oldTime = new Date(now - 10_000);
  for (const file of [oldFile, `${oldFile}.lock`, foreignFile, outsideFile]) fs.utimesSync(file, oldTime, oldTime);
  assert.equal(pruneDispatcherStates({ stateDir, olderThanMs: 5_000, now }), 1);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(`${oldFile}.lock`), false);
  assert.equal(fs.existsSync(recentFile), true);
  // Plan_65 B5: an old name the registry does not declare is not ours to delete.
  assert.equal(fs.existsSync(foreignFile), true);
  assert.equal(fs.existsSync(outsideFile), true);
  assert.equal(pruneDispatcherStates({ stateDir: path.join(stateDir, 'missing') }), 0);
});

test('a state directory outside the home layout is refused before anything is written', async () => {
  const tree = makeTempTree('dispatcher-state-layout-');
  const ids = { stateDir: path.join(tree, 'elsewhere'), sessionId: 'session-e', agentId: 'agent-e' };
  await assert.rejects(updateDispatcherState(ids, (current) => current), { code: 'EHOMEREGISTRY' });
  assert.deepEqual(fs.readdirSync(tree), []);
});
