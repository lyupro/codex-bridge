/** Plan_65 D11/A14: inspection must preserve uncertain ownership and never create or clear a home. */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { inspectLifecycleLock } from '../../cli/lifecycle-lock-inspect.mjs';
import { acquireLifecycleLock, holderLiveness, lifecycleLockAddress, parseHolder } from '../../cli/lifecycle-lock.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const socketPlatform = ['win32', 'linux'].includes(process.platform);
const socketOnly = { skip: socketPlatform ? false : 'kernel socket locks are only used on Windows and Linux' };
const expectedStrategy = process.platform === 'win32' ? 'named-pipe' : 'abstract-socket';

function home(t) {
  const tree = makeTempTree('lifecycle-inspect-');
  t.after(() => removeTempTree(tree));
  return tree;
}

function holder(homeRoot, overrides = {}) {
  return {
    pid: process.pid,
    command: 'inspect-test',
    hostRoot: path.join(homeRoot, 'host'),
    acquiredAt: '2026-09-30T08:00:00.000Z',
    token: 'inspect-token',
    ...overrides,
  };
}

function observation(result, homeRoot, strategy) {
  assert.equal(result.homeRoot, homeRoot);
  assert.equal(result.strategy, strategy);
  assert.equal(new Date(result.observedAt).toISOString(), result.observedAt);
}

function connectionStub(action) {
  let destroyed = false;
  return {
    createConnection() {
      const socket = new EventEmitter();
      socket.destroy = () => { destroyed = true; };
      setImmediate(() => action(socket));
      return socket;
    },
    wasDestroyed: () => destroyed,
  };
}

function refusal(code = 'ECONNREFUSED') {
  return connectionStub((socket) => socket.emit('error', Object.assign(new Error(code), { code })));
}

function serverStub(outcomes) {
  const servers = [];
  const createServer = () => {
    const server = new EventEmitter();
    const code = outcomes[servers.length];
    server.closed = false;
    server.listen = () => {
      setImmediate(() => code
        ? server.emit('error', Object.assign(new Error(code), { code }))
        : server.emit('listening'));
      return server;
    };
    server.close = (callback) => { server.closed = true; callback(); };
    servers.push(server);
    return server;
  };
  return { createServer, servers };
}

test('missing home is reported without creating it on every strategy', async (t) => {
  const tree = home(t);
  const missing = path.join(tree, 'missing');
  for (const [platform, strategy] of [['win32', 'named-pipe'], ['linux', 'abstract-socket'], ['darwin', 'file']]) {
    assert.equal(lifecycleLockAddress(missing, { platform }), null);
    const result = await inspectLifecycleLock(missing, { platform });
    assert.equal(result.state, 'no-home');
    observation(result, missing, strategy);
    assert.equal(fs.existsSync(missing), false);
  }
});

test('free socket inspection releases its trial hold before immediate acquisition', socketOnly, async (t) => {
  const homeRoot = home(t);
  const before = fs.readdirSync(homeRoot);
  const result = await inspectLifecycleLock(homeRoot);
  assert.equal(result.state, 'free');
  observation(result, homeRoot, expectedStrategy);
  assert.deepEqual(fs.readdirSync(homeRoot), before);
  const lock = await acquireLifecycleLock(homeRoot, { command: 'after-inspect', hostRoot: homeRoot, waitMs: 0 });
  await lock.release();
});

test('held socket inspection returns the current holder and leaves ownership intact', socketOnly, async (t) => {
  const homeRoot = home(t);
  const hostRoot = path.join(homeRoot, 'holder-host');
  const lock = await acquireLifecycleLock(homeRoot, { command: 'install', hostRoot });
  try {
    const result = await inspectLifecycleLock(homeRoot);
    assert.equal(result.state, 'held');
    observation(result, homeRoot, expectedStrategy);
    assert.equal(result.holder.command, 'install');
    assert.equal(result.holder.hostRoot, hostRoot);
    assert.equal(result.holder.pid, process.pid);
    assert.equal(result.holder.token, lock.token);
    await assert.rejects(acquireLifecycleLock(homeRoot, { command: 'other', hostRoot, waitMs: 0 }), /held by install/);
  } finally {
    await lock.release();
  }
});

test('a silent real socket holder stays unverified and does not trigger a trial hold', socketOnly, async (t) => {
  const homeRoot = home(t);
  const { address } = lifecycleLockAddress(homeRoot);
  const accepted = new Set();
  const server = net.createServer((socket) => {
    accepted.add(socket);
    socket.once('close', () => accepted.delete(socket));
  });
  const listening = once(server, 'listening');
  server.listen(address);
  await listening;
  try {
    const result = await inspectLifecycleLock(homeRoot, {
      answerTimeoutMs: 30,
      createServer: () => { assert.fail('timeout must not trial hold'); },
    });
    assert.equal(result.state, 'unverified');
    assert.match(result.reason, /timed out/);
    observation(result, homeRoot, expectedStrategy);
  } finally {
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const socket of accepted) socket.destroy();
    await closed;
  }
});

test('socket timeout, malformed answers and permission errors never imply free', async (t) => {
  const homeRoot = home(t);
  const cases = [
    ['timeout', () => {}, /timed out/],
    ['malformed', (socket) => socket.emit('data', Buffer.from('{broken}\n')), /malformed/],
    ['partial', (socket) => { socket.emit('data', Buffer.from('{"pid":')); socket.emit('end'); }, /malformed/],
    ['empty', (socket) => socket.emit('end'), /malformed/],
    ['zero pid', (socket) => socket.emit('data', Buffer.from(JSON.stringify(holder(homeRoot, { pid: 0 })) + '\n')), /malformed/],
    ['permission', (socket) => socket.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' })), /EACCES/],
    ['reset', (socket) => socket.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })), /ECONNRESET/],
    ['closed', (socket) => socket.emit('close'), /closed/],
  ];
  for (const [name, action, reason] of cases) {
    const stub = connectionStub(action);
    const result = await inspectLifecycleLock(homeRoot, {
      platform: 'linux', answerTimeoutMs: 30, createConnection: stub.createConnection,
      createServer: () => { assert.fail(`${name} must not trial hold`); },
    });
    assert.equal(result.state, 'unverified', name);
    assert.match(result.reason, reason, name);
    assert.equal(stub.wasDestroyed(), true, name);
    observation(result, homeRoot, 'abstract-socket');
  }
});

test('valid socket answers accept the first line or a complete answer ending at EOF', async (t) => {
  const homeRoot = home(t);
  const record = holder(homeRoot);
  for (const eof of [false, true]) {
    const stub = connectionStub((socket) => {
      const content = JSON.stringify(record);
      socket.emit('data', Buffer.from(content.slice(0, 10)));
      socket.emit('data', Buffer.from(content.slice(10) + (eof ? '' : '\nignored')));
      if (eof) socket.emit('end');
    });
    const result = await inspectLifecycleLock(homeRoot, { platform: 'linux', createConnection: stub.createConnection });
    assert.equal(result.state, 'held');
    assert.deepEqual(result.holder, record);
    assert.equal(stub.wasDestroyed(), true);
    observation(result, homeRoot, 'abstract-socket');
  }
});

test('explicit refusals prove free only after an exclusive trial hold and release', async (t) => {
  const homeRoot = home(t);
  for (const code of ['ECONNREFUSED', 'ENOENT']) {
    const stub = serverStub([null, 'EADDRINUSE']);
    const result = await inspectLifecycleLock(homeRoot, {
      platform: 'linux', createConnection: refusal(code).createConnection, createServer: stub.createServer,
    });
    assert.equal(result.state, 'free', code);
    assert.equal(stub.servers.length, 2);
    assert.ok(stub.servers.every((server) => server.closed));
    observation(result, homeRoot, 'abstract-socket');
  }
});

test('a holder arriving after refusal is held with unknown metadata', async (t) => {
  const homeRoot = home(t);
  const stub = serverStub(['EADDRINUSE']);
  const result = await inspectLifecycleLock(homeRoot, {
    platform: 'linux', createConnection: refusal().createConnection, createServer: stub.createServer,
  });
  assert.equal(result.state, 'held');
  assert.equal(result.holder, null);
  assert.equal(stub.servers[0].closed, true);
  observation(result, homeRoot, 'abstract-socket');
});

test('trial hold errors and failed exclusivity checks stay unverified and close listeners', async (t) => {
  const homeRoot = home(t);
  for (const [outcomes, reason] of [[['EACCES'], /EACCES/], [[null, null], /self-check failed/], [[null, 'EPERM'], /self-check failed/]]) {
    const stub = serverStub(outcomes);
    const result = await inspectLifecycleLock(homeRoot, {
      platform: 'linux', createConnection: refusal().createConnection, createServer: stub.createServer,
    });
    assert.equal(result.state, 'unverified');
    assert.match(result.reason, reason);
    assert.ok(stub.servers.every((server) => server.closed));
    observation(result, homeRoot, 'abstract-socket');
  }
});

test('a synchronous connection error is an observed unverified state', async (t) => {
  const homeRoot = home(t);
  const result = await inspectLifecycleLock(homeRoot, {
    platform: 'linux', createConnection: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); },
  });
  assert.equal(result.state, 'unverified');
  assert.equal(result.reason, 'EPERM');
  observation(result, homeRoot, 'abstract-socket');
});

test('a file-strategy home without a lock is free and remains unchanged', async (t) => {
  const homeRoot = home(t);
  const result = await inspectLifecycleLock(homeRoot, { platform: 'darwin' });
  assert.equal(result.state, 'free');
  observation(result, homeRoot, 'file');
  assert.deepEqual(fs.readdirSync(homeRoot), []);
  assert.deepEqual(lifecycleLockAddress(homeRoot, { platform: 'darwin' }), {
    strategy: 'file', address: path.join(homeRoot, '.installed.json.lock'),
  });
});

test('a valid file remains held even when its holder is dead', async (t) => {
  const homeRoot = home(t);
  const record = holder(homeRoot);
  const lockPath = path.join(homeRoot, '.installed.json.lock');
  const content = JSON.stringify(record) + '\nignored second line';
  fs.writeFileSync(lockPath, content);
  const result = await inspectLifecycleLock(homeRoot, {
    platform: 'darwin', identity: { kill: () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); } },
  });
  assert.equal(result.state, 'held');
  assert.equal(result.liveness, 'dead');
  assert.deepEqual(result.holder, record);
  observation(result, homeRoot, 'file');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), content);
});

test('empty, partial, malformed and nonpositive-pid holder files stay unverified and unchanged', async (t) => {
  const homeRoot = home(t);
  const lockPath = path.join(homeRoot, '.installed.json.lock');
  for (const content of ['', '{"pid":', 'not json\n', '\n' + JSON.stringify(holder(homeRoot)),
    JSON.stringify(holder(homeRoot, { pid: 0 })), JSON.stringify(holder(homeRoot, { pid: -1 }))]) {
    fs.writeFileSync(lockPath, content);
    const result = await inspectLifecycleLock(homeRoot, { platform: 'darwin' });
    assert.equal(result.state, 'unverified');
    assert.match(result.reason, /malformed/);
    observation(result, homeRoot, 'file');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), content);
  }
});

test('an unreadable holder path and an invalid home return unverified without throwing', async (t) => {
  const homeRoot = home(t);
  fs.mkdirSync(path.join(homeRoot, '.installed.json.lock'));
  const unreadable = await inspectLifecycleLock(homeRoot, { platform: 'darwin' });
  assert.equal(unreadable.state, 'unverified');
  assert.ok(unreadable.reason);
  observation(unreadable, homeRoot, 'file');
  const nonDirectory = path.join(homeRoot, 'not-a-directory');
  fs.writeFileSync(nonDirectory, 'unchanged');
  const invalidHome = await inspectLifecycleLock(nonDirectory, { platform: 'darwin' });
  assert.equal(invalidHome.state, 'unverified');
  observation(invalidHome, nonDirectory, 'file');
  assert.equal(fs.readFileSync(nonDirectory, 'utf8'), 'unchanged');
});

test('holder identity uses acquisition as started_at, ignores heartbeat and forwards injected probes', () => {
  const record = holder('home');
  const now = Date.parse(record.acquiredAt) + 1_000;
  let kills = 0;
  let probes = 0;
  const kill = (pid, signal) => { assert.equal(pid, record.pid); assert.equal(signal, 0); kills += 1; };
  const probe = (pid, options) => {
    probes += 1;
    assert.equal(pid, record.pid);
    assert.equal(options.started_at, record.acquiredAt);
    assert.equal(Object.hasOwn(options, 'process_started_at'), false);
    assert.equal(options.ignoreHeartbeat, true);
    assert.equal(options.now, now);
    assert.equal(options.kill, kill);
    assert.equal(options.probe, probe);
    return Date.parse(record.acquiredAt) - 86_400_000;
  };
  assert.equal(holderLiveness(record, { kill, probe, now }), 'alive');
  assert.equal(kills, 1);
  assert.equal(probes, 1);
  assert.equal(holderLiveness(record, { kill, probe: () => Date.parse(record.acquiredAt) + 86_400_000 }), 'foreign');
  assert.equal(holderLiveness(record, { kill, probe: () => null }), 'unverified');
  assert.equal(parseHolder(JSON.stringify({ ...record, pid: 0 })), null);
  assert.equal(parseHolder(JSON.stringify({ ...record, pid: -1 })), null);
});
