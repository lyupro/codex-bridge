/** Plan_56 D44: share the registry's exclusion and Windows recovery across every file writer. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
import { withFileLock, withHomeFileLock, isLockTaken } from '../src/home/lib/file-lock.mjs';
import { isLockTaken as registryIsLockTaken } from '../cli/rules-owners.mjs';
import { makeTempTree, removeTempTree } from './temp-tree.mjs';

function fixture(t) {
  const root = makeTempTree('file-lock-');
  t.after(() => removeTempTree(root));
  return path.join(root, 'resource.lock');
}

function homeFixture(t) {
  const tree = makeTempTree('home-file-lock-');
  t.after(() => removeTempTree(tree));
  const root = path.join(tree, 'home');
  return { root, writer: createHomeWriter({ root }) };
}

test('acquisition excludes a second caller until the first releases', { timeout: 2000 }, async (t) => {
  const lockPath = fixture(t);
  let enter, release, attempted;
  const entered = new Promise((resolve) => { enter = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { attempted = resolve; });
  const order = [];
  const first = withFileLock(lockPath, async () => {
    order.push('first entered');
    enter();
    await held;
    order.push('first finished');
    return 'first result';
  });
  await entered;
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    try { return await open(...args); }
    catch (error) { attempted(); throw error; }
  });
  const second = withFileLock(lockPath, () => {
    order.push('second entered');
    return 'second result';
  }, { retries: 50, delayMs: 1 });
  let results;
  try {
    await waiting;
    assert.deepEqual(order, ['first entered']);
  } finally {
    release();
    results = await Promise.all([first, second]);
  }
  assert.deepEqual(results, ['first result', 'second result']);
  assert.deepEqual(order, ['first entered', 'first finished', 'second entered']);
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
});

test('a lock older than the configured stale window is dropped and acquired', async (t) => {
  const lockPath = fixture(t);
  await fs.writeFile(lockPath, 'abandoned');
  const old = new Date(Date.now() - 1000);
  await fs.utimes(lockPath, old, old);
  const result = await withFileLock(lockPath, async () => {
    assert.equal(await fs.readFile(lockPath, 'utf8'), '');
    return 'recovered';
  }, { retries: 3, delayMs: 1, staleMs: 100 });
  assert.equal(result, 'recovered');
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
});

test('timeout names the lock path and last code without removing a live lock', async (t) => {
  const lockPath = fixture(t);
  await fs.writeFile(lockPath, 'live');
  let called = false;
  await assert.rejects(withFileLock(lockPath, () => { called = true; }, {
    retries: 3, delayMs: 1,
  }), (error) => {
    assert.ok(error.message.includes(lockPath));
    assert.match(error.message, /timed out waiting for file lock:/);
    assert.equal(isLockTaken(error.cause), true);
    assert.ok(error.message.endsWith(`(last attempt: ${error.cause.code})`));
    return true;
  });
  assert.equal(called, false);
  assert.equal(await fs.readFile(lockPath, 'utf8'), 'live');
});

test('Windows busy codes retry and the timeout reports the last failure', async (t) => {
  // The 2026-08-11 incident must stay covered without depending on a lucky Windows delete race.
  const lockPath = fixture(t);
  const errors = ['EEXIST', 'EPERM', 'EBUSY'].map((code) => Object.assign(new Error(code), { code }));
  let attempts = 0;
  t.mock.method(fs, 'open', async () => { throw errors[attempts++]; });
  await assert.rejects(withFileLock(lockPath, () => assert.fail('a busy lock cannot run the action'), {
    retries: 3, delayMs: 1,
  }), (error) => {
    assert.ok(error.message.includes(lockPath));
    assert.ok(error.message.endsWith('(last attempt: EBUSY)'));
    assert.equal(error.cause, errors[2]);
    return true;
  });
  assert.equal(attempts, 3);
  assert.equal(registryIsLockTaken, isLockTaken);
});

test('a real acquisition failure is propagated without retrying or running the action', async (t) => {
  const lockPath = fixture(t);
  const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  let attempts = 0;
  t.mock.method(fs, 'open', async () => { attempts += 1; throw error; });
  await assert.rejects(withFileLock(lockPath, () => assert.fail('acquisition failed'), {
    retries: 3, delayMs: 1,
  }), (actual) => actual === error);
  assert.equal(attempts, 1);
});

test('an action failure closes the handle and removes the lock before propagating', async (t) => {
  const lockPath = fixture(t);
  const open = fs.open;
  let handle;
  t.mock.method(fs, 'open', async (...args) => { handle = await open(...args); return handle; });
  const error = new Error('action failed');
  for (const action of [() => { throw error; }, async () => { throw error; }]) {
    await assert.rejects(withFileLock(lockPath, action), (actual) => actual === error);
    assert.equal(handle.fd, -1);
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
  }
  assert.equal(await withFileLock(lockPath, () => 'next caller'), 'next caller');
  assert.equal(handle.fd, -1);
});

test('acquisition creates missing parents as the registry lock did', async (t) => {
  const lockPath = path.join(path.dirname(fixture(t)), 'new', 'nested', 'resource.lock');
  await withFileLock(lockPath, () => fs.stat(lockPath));
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
});

test('the home lock serializes callers and removes its registered lock', { timeout: 2000 }, async (t) => {
  const { root, writer } = homeFixture(t);
  const lockPath = path.join(root, 'state', 'host-observations.json.lock');
  let enter, release, attempted;
  const entered = new Promise((resolve) => { enter = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { attempted = resolve; });
  const order = [];
  const first = withHomeFileLock(writer, 'host-observations', lockPath, async () => {
    order.push('first entered');
    enter();
    await held;
    order.push('first finished');
    return 'first result';
  });
  await entered;
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    try { return await open(...args); }
    catch (error) { attempted(); throw error; }
  });
  const second = withHomeFileLock(writer, 'host-observations', lockPath, () => {
    order.push('second entered');
    return 'second result';
  }, { retries: 50, delayMs: 1 });
  let results;
  try {
    await waiting;
    assert.deepEqual(order, ['first entered']);
  } finally {
    release();
    results = await Promise.all([first, second]);
  }
  assert.deepEqual(results, ['first result', 'second result']);
  assert.deepEqual(order, ['first entered', 'first finished', 'second entered']);
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
});

test('the home lock drops an abandoned registered lock by mtime', async (t) => {
  const { root, writer } = homeFixture(t);
  const lockPath = path.join(root, 'state', 'host-observations.json.lock');
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, 'abandoned');
  const old = new Date(Date.now() - 1000);
  await fs.utimes(lockPath, old, old);
  const result = await withHomeFileLock(writer, 'host-observations', lockPath, async () => {
    assert.equal(await fs.readFile(lockPath, 'utf8'), '');
    return 'recovered';
  }, { retries: 3, delayMs: 1, staleMs: 100 });
  assert.equal(result, 'recovered');
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
});

test('the home lock rejects an undeclared path before creating its parent', async (t) => {
  const { root, writer } = homeFixture(t);
  const lockPath = path.join(root, 'state', 'other.json.lock');
  await assert.rejects(
    withHomeFileLock(writer, 'host-observations', lockPath, () => assert.fail('invalid path ran')),
    { code: 'EHOMEREGISTRY' },
  );
  await assert.rejects(fs.stat(path.join(root, 'state')), { code: 'ENOENT' });
});
