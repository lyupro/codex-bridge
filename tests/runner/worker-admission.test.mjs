/** Guards worker takeover after Plan_60 D4/D4c, A4 r4's launcher-death double-billing risk. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { readJsonFileSync } from '../../src/home/lib/json-file.mjs';
import { kernelLockStrategy, tryHoldSocket } from '../../src/home/lib/kernel-lock.mjs';
import { acquireOrderClaim, orderClaimAddress } from '../../src/home/lib/runner/order-claim.mjs';
import { admitWorker } from '../../src/home/lib/runner/worker-admission.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const timing = { waitMs: 300, retryMs: 20, answerTimeoutMs: 200 };
const orderId = 'Order-A';
const socketTests = {
  skip: kernelLockStrategy() === null ? 'kernel socket locks are only used on Windows and Linux' : false,
};

function makeRun(projectRunsRoot, state = 'running') {
  const runDir = path.join(projectRunsRoot, 'run');
  fs.mkdirSync(runDir);
  fs.writeFileSync(path.join(runDir, 'status.json'), `${JSON.stringify({ state, pid: 123 })}\n`);
  return runDir;
}

async function assertClaimFree(projectRunsRoot) {
  const claim = await acquireOrderClaim({ projectRunsRoot, orderId, role: 'launcher', timing });
  try {
    assert.equal(claim.claimed, true);
  } finally {
    await claim.release?.();
  }
}

function assertIdentity(runDir) {
  const status = readJsonFileSync(path.join(runDir, 'status.json'));
  assert.equal(status.state, 'running');
  assert.equal(status.pid, process.pid);
  assert.equal(status.runner_pid, process.pid);
  assert.equal(typeof status.process_started_at, 'number');
  assert.equal(status.process_started_at, performance.timeOrigin);
  assert.equal(fs.existsSync(path.join(runDir, 'meta.json')), false);
}

test('an open run admits its worker, records its identity, and releases the claim', socketTests, async () => {
  const tree = makeTempTree('worker-admitted-');
  try {
    const runDir = makeRun(tree);
    assert.deepEqual(await admitWorker({ runDir, orderId, timing }), { admitted: true });
    assertIdentity(runDir);
    await assertClaimFree(tree);
  } finally {
    await removeTempTree(tree);
  }
});

for (const [label, state, withMeta] of [
  ['abandoned', 'abandoned', false],
  ['already has a verdict', 'running', true],
]) {
  test(`a run that ${label} refuses admission without writing`, socketTests, async () => {
    const tree = makeTempTree('worker-closed-');
    try {
      const runDir = makeRun(tree, state);
      const statusPath = path.join(runDir, 'status.json');
      const metaPath = path.join(runDir, 'meta.json');
      const before = fs.readFileSync(statusPath);
      if (withMeta) fs.writeFileSync(metaPath, '{"status":"FAIL"}\n');
      assert.deepEqual(await admitWorker({ runDir, orderId, timing }), {
        admitted: false, reason: 'closed', state,
      });
      assert.deepEqual(fs.readFileSync(statusPath), before);
      assert.deepEqual(fs.readdirSync(runDir).sort(), withMeta ? ['meta.json', 'status.json'] : ['status.json']);
      if (withMeta) assert.equal(fs.readFileSync(metaPath, 'utf8'), '{"status":"FAIL"}\n');
      await assertClaimFree(tree);
    } finally {
      await removeTempTree(tree);
    }
  });
}

test('missing status refuses admission without creating any artifacts', socketTests, async () => {
  const tree = makeTempTree('worker-missing-');
  try {
    const runDir = path.join(tree, 'run');
    fs.mkdirSync(runDir);
    assert.deepEqual(await admitWorker({ runDir, orderId, timing }), {
      admitted: false, reason: 'closed', state: null,
    });
    assert.deepEqual(fs.readdirSync(runDir), []);
    await assertClaimFree(tree);
  } finally {
    await removeTempTree(tree);
  }
});

test('unparseable status refuses admission and preserves its bytes', socketTests, async () => {
  const tree = makeTempTree('worker-invalid-');
  try {
    const runDir = makeRun(tree);
    const statusPath = path.join(runDir, 'status.json');
    fs.writeFileSync(statusPath, '{invalid JSON\n');
    const before = fs.readFileSync(statusPath);
    assert.deepEqual(await admitWorker({ runDir, orderId, timing }), {
      admitted: false, reason: 'closed', state: null,
    });
    assert.deepEqual(fs.readFileSync(statusPath), before);
    await assertClaimFree(tree);
  } finally {
    await removeTempTree(tree);
  }
});

test('a launcher holding the same order claim refuses the worker with its parsed identity', socketTests, async () => {
  const tree = makeTempTree('worker-busy-');
  let claim;
  try {
    const runDir = makeRun(tree);
    const statusPath = path.join(runDir, 'status.json');
    const before = fs.readFileSync(statusPath);
    claim = await acquireOrderClaim({ projectRunsRoot: tree, orderId, role: 'launcher', timing });
    assert.equal(claim.claimed, true);
    const admission = await admitWorker({ runDir, orderId, timing });
    assert.equal(admission.admitted, false);
    assert.equal(admission.reason, 'claim-timeout');
    assert.equal(admission.holder.role, 'launcher');
    assert.equal(admission.holder.pid, process.pid);
    assert.equal(admission.holder.orderId, orderId);
    assert.equal(typeof admission.holder.token, 'string');
    assert.ok(Number.isFinite(Date.parse(admission.holder.acquiredAt)));
    assert.deepEqual(fs.readFileSync(statusPath), before);
    assert.deepEqual(fs.readdirSync(runDir), ['status.json']);
  } finally {
    await claim?.release();
    await removeTempTree(tree);
  }
});

test('a silent holder refuses admission without writing', socketTests, async () => {
  const tree = makeTempTree('worker-silent-');
  let release;
  try {
    const runDir = makeRun(tree);
    const statusPath = path.join(runDir, 'status.json');
    const before = fs.readFileSync(statusPath);
    release = await tryHoldSocket(orderClaimAddress(tree, orderId));
    assert.equal(typeof release, 'function');
    assert.deepEqual(await admitWorker({ runDir, orderId, timing }), {
      admitted: false, reason: 'claim-timeout', holder: null,
    });
    assert.deepEqual(fs.readFileSync(statusPath), before);
    assert.deepEqual(fs.readdirSync(runDir), ['status.json']);
  } finally {
    await release?.();
    await removeTempTree(tree);
  }
});

test('identity is written while the injected claim server still holds the order', socketTests, async (t) => {
  const tree = makeTempTree('worker-identity-');
  try {
    const runDir = makeRun(tree);
    const servers = [];
    const createServer = (listener) => {
      const server = net.createServer(listener);
      servers.push(server);
      return server;
    };
    const writeFileSync = fs.writeFileSync;
    let checked = false;
    t.mock.method(fs, 'writeFileSync', (file, ...args) => {
      assert.equal(file, path.join(runDir, 'status.json'));
      assert.equal(servers[0].listening, true);
      checked = true;
      return writeFileSync(file, ...args);
    });
    assert.deepEqual(await admitWorker({ runDir, orderId, timing, createServer }), { admitted: true });
    assert.equal(checked, true);
    assert.equal(servers[0].listening, false);
    assertIdentity(runDir);
    await assertClaimFree(tree);
  } finally {
    t.mock.restoreAll();
    await removeTempTree(tree);
  }
});

test('a failed identity write propagates the error and releases the claim', socketTests, async (t) => {
  const tree = makeTempTree('worker-write-error-');
  try {
    const runDir = makeRun(tree);
    const before = fs.readFileSync(path.join(runDir, 'status.json'));
    const failure = new Error('identity write failed');
    t.mock.method(fs, 'writeFileSync', () => { throw failure; });
    await assert.rejects(admitWorker({ runDir, orderId, timing }), (error) => error === failure);
    t.mock.restoreAll();
    assert.deepEqual(fs.readFileSync(path.join(runDir, 'status.json')), before);
    await assertClaimFree(tree);
  } finally {
    t.mock.restoreAll();
    await removeTempTree(tree);
  }
});

test('an unsupported platform admits an open run without opening a socket', async () => {
  const tree = makeTempTree('worker-unsupported-');
  try {
    const runDir = makeRun(tree);
    assert.deepEqual(await admitWorker({
      runDir, orderId, platform: 'darwin',
      createServer: () => { throw new Error('unsupported platforms must not open a socket'); },
    }), { admitted: true });
    assertIdentity(runDir);
  } finally {
    await removeTempTree(tree);
  }
});
