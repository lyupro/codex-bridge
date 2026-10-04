/** Guards the shared kernel claim after Plan_60 D4's 2026-09-24 double-billing incident. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import {
  acquireKernelLock, directoryDigest, kernelLockAddress, kernelLockStrategy, tryHoldSocket,
} from '../src/home/lib/kernel-lock.mjs';
import { makeTempTree, removeTempTree } from './temp-tree.mjs';

const socketTests = {
  skip: kernelLockStrategy() === null ? 'kernel socket locks are only used on Windows and Linux' : false,
};
const moduleUrl = new URL('../src/home/lib/kernel-lock.mjs', import.meta.url).href;
const childSource = [
  'import { acquireKernelLock, kernelLockAddress } from ' + JSON.stringify(moduleUrl) + ';',
  'try {',
  '  await acquireKernelLock({',
  '    address: kernelLockAddress("order", process.argv[2]), holder: { pid: process.pid, token: "child" },',
  '    waitMs: 0, retryMs: 20, answerTimeoutMs: 500, parseAnswer: JSON.parse, label: "order claim",',
  '  });',
  '  process.stdout.write("ready\\n");',
  '  setInterval(() => {}, 1000);',
  '} catch (error) { process.stdout.write("error: " + error.message + "\\n"); process.exitCode = 2; }',
].join('\n');

function options(address, holder = { pid: process.pid, token: 'parent' }) {
  return {
    address, holder, waitMs: 0, retryMs: 20, answerTimeoutMs: 500,
    parseAnswer: JSON.parse, label: 'order claim',
  };
}

function startChild(tree, digest) {
  const script = path.join(tree, 'kernel-child.mjs');
  fs.writeFileSync(script, childSource);
  const child = spawn(process.execPath, [script, digest], { windowsHide: true });
  const firstLine = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('child did not answer')), 5_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline !== -1) {
        clearTimeout(timer);
        resolve(output.slice(0, newline));
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (output.includes('\n')) return;
      clearTimeout(timer);
      reject(new Error('child exited before answering: ' + code + ' ' + signal + ' ' + output));
    });
  });
  return { child, firstLine };
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

test('strategy and address declare the kernel namespace on each platform', () => {
  for (const [platform, strategy, address] of [
    ['win32', 'named-pipe', '\\\\.\\pipe\\codex-bridge-order-abc'],
    ['linux', 'abstract-socket', '\0codex-bridge-order-abc'],
    ['darwin', null, null],
  ]) {
    assert.equal(kernelLockStrategy(platform), strategy);
    assert.equal(kernelLockAddress('order', 'abc', platform), address);
  }
  assert.equal(kernelLockStrategy(), kernelLockStrategy(process.platform));
  assert.equal(kernelLockAddress('order', 'abc'), kernelLockAddress('order', 'abc', process.platform));
  assert.notEqual(kernelLockAddress('lifecycle', 'abc', 'win32'), kernelLockAddress('order', 'abc', 'win32'));
});

test('purpose validation rejects names outside the declared grammar on every platform', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const purpose of ['', 'Order', '1order', '-order', 'order_id', 'order/claim', 'order\n', null, 1]) {
      assert.throws(() => kernelLockAddress(purpose, 'abc', platform), TypeError);
    }
    assert.doesNotThrow(() => kernelLockAddress('order-claim', 'abc', platform));
  }
});

test('directory digest hashes bigint identity and an optional non-empty suffix', async () => {
  const tree = makeTempTree('kernel-digest-');
  try {
    const stat = fs.statSync(tree, { bigint: true });
    const identity = `${stat.dev}:${stat.ino}`;
    const hash = (value) => createHash('sha256').update(value).digest('hex');
    assert.equal(directoryDigest(tree), hash(identity));
    assert.equal(directoryDigest(tree, { suffix: 'order-id' }), hash(`${identity}:order-id`));
    assert.notEqual(directoryDigest(tree, { suffix: 'first' }), directoryDigest(tree, { suffix: 'second' }));
    for (const suffix of ['', null, 1]) assert.equal(directoryDigest(tree, { suffix }), hash(identity));
    assert.equal(directoryDigest(path.join(tree, 'missing')), null);
    const file = path.join(tree, 'file');
    fs.writeFileSync(file, 'fixture\n');
    assert.throws(() => directoryDigest(file), { message: `${file} is not a directory` });
  } finally {
    await removeTempTree(tree);
  }
});

test('Windows spelling aliases have the same directory identity', {
  skip: process.platform === 'win32' ? false : 'letter case aliases are Windows-specific',
}, async () => {
  const tree = makeTempTree('kernel-spelling-');
  try {
    const digest = directoryDigest(tree);
    assert.equal(directoryDigest(tree.replaceAll('\\', '/')), digest);
    assert.equal(directoryDigest(tree.toUpperCase()), digest);
  } finally {
    await removeTempTree(tree);
  }
});

test('a waiter reports the holder and idempotent release permits reacquisition', socketTests, async () => {
  const tree = makeTempTree('kernel-held-');
  const address = kernelLockAddress('order', directoryDigest(tree));
  const holder = { pid: process.pid, token: 'first', order: 'same-id' };
  let first;
  let second;
  try {
    first = await acquireKernelLock(options(address, holder));
    assert.equal(first.held, true);
    assert.ok(Number.isFinite(Date.parse(holder.acquiredAt)));
    let answer;
    const busy = await acquireKernelLock({
      ...options(address), waitMs: 50,
      parseAnswer: (line) => { answer = line; return JSON.parse(line); },
    });
    assert.deepEqual(busy, { held: false, holder });
    assert.equal(answer, JSON.stringify(holder));
    assert.equal(await tryHoldSocket(address), 'in-use');
    const releasing = first.release();
    assert.equal(first.release(), releasing);
    await releasing;
    second = await acquireKernelLock(options(address));
    assert.equal(second.held, true);
  } finally {
    await first?.release();
    await second?.release();
    await removeTempTree(tree);
  }
});

test('a retry acquires when the holder releases before the deadline', socketTests, async () => {
  const tree = makeTempTree('kernel-retry-');
  const address = kernelLockAddress('order', directoryDigest(tree));
  let first;
  let second;
  try {
    first = await acquireKernelLock(options(address));
    const waiting = acquireKernelLock({ ...options(address), waitMs: 500 });
    await first.release();
    second = await waiting;
    assert.equal(second.held, true);
  } finally {
    await first?.release();
    await second?.release();
    await removeTempTree(tree);
  }
});

test('a silent holder produces a null diagnosis without granting a claim', socketTests, async () => {
  const tree = makeTempTree('kernel-silent-');
  const address = kernelLockAddress('order', directoryDigest(tree));
  const release = await tryHoldSocket(address);
  try {
    const busy = await acquireKernelLock({
      ...options(address), parseAnswer: (line) => line.length === 0 ? null : JSON.parse(line),
    });
    assert.deepEqual(busy, { held: false, holder: null });
  } finally {
    await release();
    await removeTempTree(tree);
  }
});

test('hard-killing a child frees the kernel name without waiting or removing an artifact', socketTests, async () => {
  const tree = makeTempTree('kernel-killed-');
  const digest = directoryDigest(tree);
  const address = kernelLockAddress('order', digest);
  const { child, firstLine } = startChild(tree, digest);
  let lock;
  try {
    assert.equal(await firstLine, 'ready');
    const busy = await acquireKernelLock(options(address));
    assert.equal(busy.held, false);
    assert.equal(busy.holder.pid, child.pid);
    await killChild(child);
    // Plan_60 D4: a dead launcher must not leave a claim that another launcher has to steal.
    lock = await acquireKernelLock(options(address));
    assert.equal(lock.held, true);
    assert.deepEqual(fs.readdirSync(tree), ['kernel-child.mjs']);
  } finally {
    await killChild(child);
    await lock?.release();
    await removeTempTree(tree);
  }
});

test('a successful second listen fails with the caller label and closes both listeners', async () => {
  const servers = [];
  const holder = { token: 'self-check' };
  const createServer = () => {
    const server = new EventEmitter();
    server.listen = () => {
      if (servers.length === 2) assert.ok(Number.isFinite(Date.parse(holder.acquiredAt)));
      queueMicrotask(() => server.emit('listening'));
    };
    server.close = (callback) => { server.closed = true; callback(); };
    servers.push(server);
    return server;
  };
  await assert.rejects(
    acquireKernelLock({ ...options('fake-address', holder), createServer }),
    { message: 'order claim self-check failed: a second listener succeeded' },
  );
  assert.equal(servers.length, 2);
  assert.ok(servers.every((server) => server.closed));
});

test('acquisition unrefs the holder and release destroys accepted sockets exactly once', async () => {
  let onConnection;
  let closes = 0;
  let unrefs = 0;
  let calls = 0;
  const createServer = (handler) => {
    const server = new EventEmitter();
    calls += 1;
    const probe = calls === 2;
    if (!probe) onConnection = handler;
    server.listen = () => queueMicrotask(() => {
      if (probe) server.emit('error', Object.assign(new Error('held'), { code: 'EADDRINUSE' }));
      else server.emit('listening');
    });
    server.close = (callback) => { if (!probe) closes += 1; callback(); };
    server.unref = () => { unrefs += 1; };
    return server;
  };
  const holder = { token: 'accepted' };
  const lock = await acquireKernelLock({ ...options('fake-address', holder), createServer });
  const socket = new EventEmitter();
  let answer;
  let destroys = 0;
  socket.end = (line) => { answer = line; };
  socket.destroy = () => { destroys += 1; socket.emit('close'); };
  onConnection(socket);
  assert.equal(answer, JSON.stringify(holder) + '\n');
  assert.equal(unrefs, 1);
  const releasing = lock.release();
  assert.equal(lock.release(), releasing);
  await releasing;
  assert.equal(closes, 1);
  assert.equal(destroys, 1);
});

test('non-EADDRINUSE listen failures propagate without retrying', async () => {
  const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  let calls = 0;
  const createServer = () => {
    calls += 1;
    const server = new EventEmitter();
    server.listen = () => { throw failure; };
    server.close = (callback) => callback();
    return server;
  };
  await assert.rejects(acquireKernelLock({ ...options('fake-address'), createServer }), (error) => error === failure);
  assert.equal(calls, 1);
});
