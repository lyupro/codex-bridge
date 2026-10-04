/** Guards order identity and refusal after Plan_60 D4/D4c's 2026-09-24 double-billing incident. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import {
  directoryDigest, kernelLockAddress, kernelLockStrategy, tryHoldSocket,
} from '../../src/home/lib/kernel-lock.mjs';
import {
  acquireOrderClaim, ORDER_CLAIM_TIMING, orderClaimAddress, orderClaimBusyText, parseClaimHolder,
} from '../../src/home/lib/runner/order-claim.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const timing = { waitMs: 300, retryMs: 20, answerTimeoutMs: 100 };
const socketTests = {
  skip: kernelLockStrategy() === null ? 'kernel socket locks are only used on Windows and Linux' : false,
};
const validHolder = {
  pid: 123, role: 'launcher', orderId: 'Order-A', token: 'holder-token', acquiredAt: '2026-10-04T12:00:00.000Z',
};

function options(projectRunsRoot, orderId = 'Order-A', role = 'launcher') {
  return { projectRunsRoot, orderId, role, timing };
}

test('preparation timing is fixed and frozen', () => {
  assert.deepEqual(ORDER_CLAIM_TIMING, { waitMs: 60_000, retryMs: 100, answerTimeoutMs: 1_000 });
  assert.equal(Object.isFrozen(ORDER_CLAIM_TIMING), true);
});

test('addresses use physical directory identity and the exact order id', async () => {
  const tree = makeTempTree('order-address-');
  try {
    for (const orderId of ['Order-A', 'order-a', 'order/a', 'order a', ' order-a ', '订单']) {
      for (const platform of ['win32', 'linux', 'darwin']) {
        assert.equal(
          orderClaimAddress(tree, orderId, platform),
          kernelLockAddress('order', directoryDigest(tree, { suffix: orderId }), platform),
        );
      }
    }
    assert.equal(orderClaimAddress(tree, 'Order-A'), orderClaimAddress(tree, 'Order-A', process.platform));
  } finally {
    await removeTempTree(tree);
  }
});

test('a second claimant times out with the first holder, then acquires after release', socketTests, async () => {
  const tree = makeTempTree('order-held-');
  let first;
  let second;
  try {
    first = await acquireOrderClaim(options(tree));
    assert.equal(first.claimed, true);
    const busy = await acquireOrderClaim(options(tree, 'Order-A', 'worker'));
    assert.equal(busy.claimed, false);
    assert.equal(busy.busy, true);
    assert.equal(busy.holder.role, 'launcher');
    assert.equal(busy.holder.pid, process.pid);
    assert.equal(busy.holder.orderId, 'Order-A');
    assert.match(busy.holder.token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(Number.isFinite(Date.parse(busy.holder.acquiredAt)));
    assert.equal('release' in busy, false);
    await first.release();
    second = await acquireOrderClaim(options(tree, 'Order-A', 'worker'));
    assert.equal(second.claimed, true);
    const workerBusy = await acquireOrderClaim(options(tree));
    assert.equal(workerBusy.busy, true);
    assert.equal(workerBusy.holder.role, 'worker');
    assert.notEqual(workerBusy.holder.token, busy.holder.token);
  } finally {
    await first?.release();
    await second?.release();
    await removeTempTree(tree);
  }
});

test('a waiting claimant acquires if preparation finishes before expiry', socketTests, async () => {
  const tree = makeTempTree('order-wait-');
  let first;
  let waiting;
  let second;
  try {
    first = await acquireOrderClaim(options(tree));
    waiting = acquireOrderClaim(options(tree, 'Order-A', 'worker'));
    await first.release();
    second = await waiting;
    assert.equal(second.claimed, true);
  } finally {
    await first?.release();
    second ??= await waiting;
    await second?.release?.();
    await removeTempTree(tree);
  }
});

for (const [firstId, secondId] of [['Order-A', 'Order-B'], ['Order-A', 'order-a']]) {
  test(`independent order ids: ${firstId} and ${secondId}`, socketTests, async () => {
    const tree = makeTempTree('order-independent-');
    let first;
    let second;
    try {
      first = await acquireOrderClaim(options(tree, firstId));
      second = await acquireOrderClaim(options(tree, secondId));
      assert.equal(first.claimed, true);
      assert.equal(second.claimed, true);
    } finally {
      await first?.release();
      await second?.release();
      await removeTempTree(tree);
    }
  });
}

test('Windows slash and letter case aliases contend on the same claim', {
  skip: process.platform === 'win32' ? false : 'letter case aliases are Windows-specific',
}, async () => {
  const tree = makeTempTree('order-spelling-');
  let first;
  const contenders = [];
  try {
    first = await acquireOrderClaim(options(tree));
    assert.equal(first.claimed, true);
    for (const alias of [tree.replaceAll('\\', '/'), tree.toUpperCase()]) {
      assert.equal(orderClaimAddress(alias, 'Order-A'), orderClaimAddress(tree, 'Order-A'));
      const busy = await acquireOrderClaim(options(alias, 'Order-A', 'worker'));
      contenders.push(busy);
      assert.equal(busy.claimed, false);
      assert.equal(busy.busy, true);
      assert.equal(busy.holder.orderId, 'Order-A');
      assert.equal(busy.holder.pid, process.pid);
    }
  } finally {
    await first?.release();
    for (const contender of contenders) await contender.release?.();
    await removeTempTree(tree);
  }
});

test('different project run folders have independent claims for the same order id', socketTests, async () => {
  const firstTree = makeTempTree('order-project-a-');
  const secondTree = makeTempTree('order-project-b-');
  let first;
  let second;
  try {
    assert.notEqual(orderClaimAddress(firstTree, 'Order-A'), orderClaimAddress(secondTree, 'Order-A'));
    first = await acquireOrderClaim(options(firstTree));
    second = await acquireOrderClaim(options(secondTree));
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, true);
  } finally {
    await first?.release();
    await second?.release();
    await removeTempTree(firstTree);
    await removeTempTree(secondTree);
  }
});

test('unsupported platforms return an unclaimed result with a harmless release', async () => {
  const tree = makeTempTree('order-unsupported-');
  let claim;
  try {
    claim = await acquireOrderClaim({
      ...options(tree), platform: 'darwin',
      createServer: () => { throw new Error('unsupported platforms must not open a socket'); },
    });
    assert.equal(orderClaimAddress(tree, 'Order-A', 'darwin'), null);
    assert.equal(claim.claimed, false);
    assert.equal(claim.unsupported, true);
    assert.equal('busy' in claim, false);
    await assert.doesNotReject(claim.release());
  } finally {
    await claim?.release();
    await removeTempTree(tree);
  }
});

test('missing project folders and invalid required order ids or roles fail loud', async () => {
  const tree = makeTempTree('order-invalid-');
  try {
    const missing = path.join(tree, 'missing');
    const expected = { message: `project runs folder does not exist: ${missing}` };
    assert.throws(() => orderClaimAddress(missing, 'Order-A'), expected);
    await assert.rejects(acquireOrderClaim(options(missing)), expected);
    for (const orderId of ['', undefined, null, 1, {}, []]) {
      assert.throws(() => orderClaimAddress(tree, orderId), TypeError);
      await assert.rejects(acquireOrderClaim({ ...options(tree), orderId }), TypeError);
    }
    for (const role of ['', undefined, null, 1, 'Launcher', 'other', {}]) {
      await assert.rejects(acquireOrderClaim({ ...options(tree), role }), TypeError);
    }
  } finally {
    await removeTempTree(tree);
  }
});

test('holder parsing accepts both roles and preserves the diagnosis record', () => {
  for (const role of ['launcher', 'worker']) {
    const holder = { ...validHolder, role };
    assert.deepEqual(parseClaimHolder(JSON.stringify(holder)), holder);
  }
});

test('holder parsing rejects malformed JSON, records, and every malformed field without throwing', () => {
  for (const line of ['', '{', 'null', '[]', 'true', '123', '"holder"', undefined]) {
    assert.equal(parseClaimHolder(line), null);
  }
  const invalidFields = {
    pid: [undefined, null, 0, -1, 1.5, '123', true],
    role: [undefined, null, '', 'Launcher', 'other', 1],
    orderId: [undefined, null, '', 1, {}, []],
    token: [undefined, null, '', 1, {}, []],
    acquiredAt: [undefined, null, '', 1, {}, []],
  };
  for (const [key, values] of Object.entries(invalidFields)) {
    for (const value of values) {
      assert.equal(parseClaimHolder(JSON.stringify({ ...validHolder, [key]: value })), null, key);
    }
  }
});

test('busy diagnostics explain refusal and unspent quota with and without an answer', () => {
  const tail = '; repeat the same command later — it attaches to that run instead of starting another. '
    + 'The run folder was not created; quota was not spent.';
  for (const role of ['launcher', 'worker']) {
    const holder = { ...validHolder, role };
    const text = orderClaimBusyText('Order-A', holder);
    assert.equal(text, `order id "Order-A" is being launched by ${role} pid 123 since ${holder.acquiredAt}${tail}`);
    assert.ok(text.endsWith('quota was not spent.'));
    assert.equal(text.includes('\n'), false);
  }
  const silent = orderClaimBusyText('Order-A', null);
  assert.equal(silent, `order id "Order-A" is being launched by a process that did not answer (unverified)${tail}`);
  assert.ok(silent.endsWith('quota was not spent.'));
  assert.equal(silent.includes('\n'), false);
});

test('a silent kernel holder refuses with an unverified diagnosis', socketTests, async () => {
  const tree = makeTempTree('order-silent-');
  let release;
  let claim;
  try {
    release = await tryHoldSocket(orderClaimAddress(tree, 'Order-A'));
    claim = await acquireOrderClaim(options(tree));
    assert.deepEqual(claim, { claimed: false, busy: true, holder: null });
  } finally {
    await claim?.release?.();
    await release?.();
    await removeTempTree(tree);
  }
});

test('unexpected kernel errors propagate unchanged', async () => {
  const tree = makeTempTree('order-error-');
  const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  let claim;
  try {
    const createServer = () => {
      const server = new EventEmitter();
      server.listen = () => { throw failure; };
      server.close = (callback) => callback();
      return server;
    };
    const platform = kernelLockStrategy() === null ? 'linux' : process.platform;
    await assert.rejects(async () => {
      claim = await acquireOrderClaim({ ...options(tree), platform, createServer });
    }, (error) => error === failure);
  } finally {
    await claim?.release?.();
    await removeTempTree(tree);
  }
});
