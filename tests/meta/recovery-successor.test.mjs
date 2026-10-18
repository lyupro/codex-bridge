/** Plan_80 E18: resolve only the recorded automatic successor, without side effects. */
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverySuccessor } from '../../src/home/lib/meta/recovery-successor.mjs';
import { HEARTBEAT_FILE } from '../../src/home/lib/heartbeat.mjs';
import { makeChainRoot } from './test-fixtures.mjs';
import { makeTempTree } from '../temp-tree.mjs';

const identity = {
  order_id: 'order', agent: 'codex-advisor', slug: 'task', repo: '/repo/task',
  phase: 'advise', task_hash: 'hash', task_hash_scheme: 2, continued_from: 'scope',
};
const parentStatus = () => ({
  ...identity, state: 'finished', recovery: { automatic: true, child: 'child', reserved_at: 'now' },
});
const childStatus = () => ({
  ...identity, state: 'abandoned', resumed_from: 'parent',
  recovery: { automatic: true, attempt: 2, parent: 'parent', reserved_at: 'now' },
});
const zeroMeta = {
  exit: null, session_id: null, events_bytes: 0, stderr_bytes: 0, tokens_reported: false,
};

function pair(parent, child, { childFolder = true, heartbeat = false } = {}) {
  const root = makeChainRoot([
    { name: 'parent', status: null },
    ...(childFolder ? [{ name: 'child', status: null, meta: zeroMeta }] : []),
  ]);
  for (const [name, status] of [['parent', parent], ['child', child]]) {
    if (status !== undefined && (name !== 'child' || childFolder)) {
      fs.writeFileSync(path.join(root, name, 'status.json'), JSON.stringify(status));
    }
  }
  if (heartbeat) fs.writeFileSync(path.join(root, 'child', HEARTBEAT_FILE), '');
  return root;
}

const expectInvalid = (root, reason) => {
  assert.deepEqual(recoverySuccessor(root, 'parent'), { state: 'invalid', reason });
};

test('none requires a readable parent with no own recovery property and never infers a child', () => {
  const parent = { ...identity, recovery_policy: { automatic: true } };
  const root = pair(parent, childStatus());
  assert.deepEqual(recoverySuccessor(root, 'parent'), { state: 'none' });
});

for (const status of [undefined, null, [], 3, 'status']) {
  test(`parent-status-unreadable for parent status ${JSON.stringify(status)}`, () => {
    expectInvalid(pair(status, childStatus()), 'parent-status-unreadable');
  });
}

test('parent-status-unreadable for malformed JSON before any pointer validation', () => {
  const root = pair(parentStatus(), childStatus());
  fs.writeFileSync(path.join(root, 'parent', 'status.json'), '{');
  expectInvalid(root, 'parent-status-unreadable');
});

test('parent-status-unreadable for a missing parent folder', () => {
  expectInvalid(makeTempTree('recovery-successor-'), 'parent-status-unreadable');
});

for (const pointer of [null, [], true, 'child', {}, { automatic: false, child: 'child' },
  { automatic: 1, child: 'child' }, { automatic: true }, { automatic: true, child: '' },
  { automatic: true, child: 2 }]) {
  test(`pointer-shape for ${JSON.stringify(pointer)}`, () => {
    expectInvalid(pair({ ...parentStatus(), recovery: pointer }, childStatus()), 'pointer-shape');
  });
}

for (const child of ['.', '..', 'a/b', 'a\\b', 'parent']) {
  test(`child-name refuses ${JSON.stringify(child)} before checking its folder`, () => {
    const parent = { ...parentStatus(), recovery: { automatic: true, child } };
    expectInvalid(pair(parent, undefined, { childFolder: false }), 'child-name');
  });
}

test('pointer-shape wins over child-name', () => {
  expectInvalid(pair({ ...parentStatus(), recovery: { automatic: false, child: '..' } },
    undefined, { childFolder: false }), 'pointer-shape');
});

test('child-missing for an absent child folder', () => {
  expectInvalid(pair(parentStatus(), undefined, { childFolder: false }), 'child-missing');
});

test('child-missing when the child path is a file', () => {
  const root = pair(parentStatus(), undefined, { childFolder: false });
  fs.writeFileSync(path.join(root, 'child'), 'not a directory');
  expectInvalid(root, 'child-missing');
});

for (const status of [undefined, null, [], 3, 'status']) {
  test(`child-missing for child status ${JSON.stringify(status)}`, () => {
    expectInvalid(pair(parentStatus(), status), 'child-missing');
  });
}

test('child-missing for malformed child JSON before marker validation', () => {
  const root = pair(parentStatus(), childStatus());
  fs.writeFileSync(path.join(root, 'child', 'status.json'), '{');
  expectInvalid(root, 'child-missing');
});

for (const patch of [
  { recovery: null },
  { recovery: { automatic: false, attempt: 2, parent: 'parent' } },
  { recovery: { automatic: true, attempt: 1, parent: 'parent' } },
  { resumed_from: 'other' },
  { resumed_from: 'other', recovery: { automatic: true, attempt: 2, parent: 'other' } },
]) {
  test(`child-marker refuses ${JSON.stringify(patch)}`, () => {
    expectInvalid(pair(parentStatus(), { ...childStatus(), ...patch }), 'child-marker');
  });
}

test('child-marker wins over identity', () => {
  expectInvalid(pair(parentStatus(), { ...childStatus(), resumed_from: 'other', order_id: 'wrong' }),
    'child-marker');
});

for (const key of Object.keys(identity)) {
  test(`identity compares ${key}, including presence on only one side`, () => {
    expectInvalid(pair(parentStatus(), { ...childStatus(), [key]: 'different' }), 'identity');
    const parent = parentStatus();
    const child = childStatus();
    delete child[key];
    expectInvalid(pair(parent, child), 'identity');
    delete parent[key];
    const root = pair(parent, child);
    assert.deepEqual(recoverySuccessor(root, 'parent'), {
      state: 'valid', child: 'child', childDir: path.join(root, 'child'), started: false,
    });
    child[key] = null;
    expectInvalid(pair(parent, child), 'identity');
  });
}

test('a valid automatic child with heartbeat has started', () => {
  const root = pair(parentStatus(), childStatus(), { heartbeat: true });
  assert.deepEqual(recoverySuccessor(root, 'parent'), {
    state: 'valid', child: 'child', childDir: path.join(root, 'child'), started: true,
  });
});

test('a valid abandoned child without start evidence has not started', () => {
  const root = pair(parentStatus(), childStatus());
  assert.deepEqual(recoverySuccessor(root, 'parent'), {
    state: 'valid', child: 'child', childDir: path.join(root, 'child'), started: false,
  });
});

function snapshot(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? [entry.name, snapshot(file)] : [entry.name, fs.readFileSync(file)];
    });
}

test('all resolver outcomes preserve folder listings and file bytes', () => {
  for (const root of [
    pair(parentStatus(), childStatus()),
    pair(parentStatus(), childStatus(), { heartbeat: true }),
    pair(identity, childStatus()),
    pair(parentStatus(), undefined, { childFolder: false }),
    makeTempTree('recovery-successor-empty-'),
  ]) {
    const before = snapshot(root);
    recoverySuccessor(root, 'parent');
    assert.deepEqual(snapshot(root), before);
  }
});
