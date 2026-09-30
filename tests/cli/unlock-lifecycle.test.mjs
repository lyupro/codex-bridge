/** Plan_65 D11/A14: lifecycle inspection preserves ownership; explicit clearing removes only dead locks. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { COMMANDS } from '../../cli/command-registry.mjs';
import { acquireLifecycleLock } from '../../cli/lifecycle-lock.mjs';
import { unlock } from '../../cli/unlock.mjs';
import { createHomeWriter } from '../../src/home/lib/home-write.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const socketOnly = {
  skip: ['win32', 'linux'].includes(process.platform)
    ? false : 'kernel socket locks are only used on Windows and Linux',
};
const socketStrategy = process.platform === 'win32' ? 'named-pipe' : 'abstract-socket';

function home(t) {
  const tree = makeTempTree('unlock-lifecycle-');
  t.after(() => removeTempTree(tree));
  return tree;
}

function holder(homeRoot) {
  return {
    command: 'update', hostRoot: path.join(homeRoot, 'host'), pid: process.pid,
    acquiredAt: '2026-09-30T08:00:00.000Z', token: 'unlock-lifecycle-token',
  };
}

function assertHeader(output, homeRoot, strategy) {
  const firstLine = output.split('\n')[0];
  const prefix = `Lifecycle lock of ${homeRoot} (${strategy}), observed `;
  assert.ok(firstLine.startsWith(prefix), firstLine);
  assert.ok(firstLine.endsWith(':'), firstLine);
  const observedAt = firstLine.slice(prefix.length, -1);
  assert.equal(new Date(observedAt).toISOString(), observedAt);
}

test('file strategy reports a free home without creating a lock', async (t) => {
  const homeRoot = home(t);
  const pending = unlock(['--lifecycle'], { homeRoot, inspect: { platform: 'darwin' } });
  assert.ok(pending instanceof Promise);
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assertHeader(result.output, homeRoot, 'file');
  assert.equal(result.output.split('\n')[1], 'free — no install, update or uninstall holds it.');
  assert.deepEqual(fs.readdirSync(homeRoot), []);
});

test('a dead file holder is reported with a future clear pointer and unchanged bytes', async (t) => {
  const homeRoot = home(t);
  const record = holder(homeRoot);
  const lockPath = path.join(homeRoot, '.installed.json.lock');
  const content = Buffer.from(JSON.stringify(record) + '\r\nignored second line\r\n');
  fs.writeFileSync(lockPath, content);
  const result = await unlock(['--lifecycle'], {
    homeRoot,
    inspect: {
      platform: 'darwin',
      identity: { kill: () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); } },
    },
  });
  assert.equal(result.exitCode, 0);
  assertHeader(result.output, homeRoot, 'file');
  assert.equal(result.output.split('\n')[1],
    `held by ${record.command} for ${record.hostRoot}, pid ${record.pid}, since ${record.acquiredAt}.`);
  assert.equal(result.output.split('\n')[2], 'Holder process: dead.');
  assert.match(result.output, /file was left by a crash/);
  assert.match(result.output, /Clear it with codex-bridge unlock --lifecycle --clear$/m);
  assert.deepEqual(fs.readFileSync(lockPath), content);
});

test('other file holder identities are observations without a crash or clear pointer', async (t) => {
  const homeRoot = home(t);
  const record = holder(homeRoot);
  const lockPath = path.join(homeRoot, '.installed.json.lock');
  const content = Buffer.from(JSON.stringify(record) + '\n');
  fs.writeFileSync(lockPath, content);
  for (const [liveness, probe] of [
    ['alive', () => Date.parse(record.acquiredAt) - 86_400_000],
    ['foreign', () => Date.parse(record.acquiredAt) + 86_400_000],
    ['unverified', () => null],
  ]) {
    const result = await unlock(['--lifecycle'], {
      homeRoot, inspect: { platform: 'darwin', identity: { kill: () => {}, probe } },
    });
    assert.equal(result.exitCode, 0);
    assertHeader(result.output, homeRoot, 'file');
    assert.equal(result.output.split('\n')[2], `Holder process: ${liveness}.`);
    assert.doesNotMatch(result.output, /crash|--clear/);
    assert.deepEqual(fs.readFileSync(lockPath), content);
  }
});

test('an empty file lock is unverified and stays unchanged', async (t) => {
  const homeRoot = home(t);
  const lockPath = path.join(homeRoot, '.installed.json.lock');
  fs.writeFileSync(lockPath, '');
  const result = await unlock(['--lifecycle'], { homeRoot, inspect: { platform: 'darwin' } });
  assert.equal(result.exitCode, 1);
  assertHeader(result.output, homeRoot, 'file');
  assert.equal(result.output.split('\n')[1], 'could not be verified: malformed holder file. Nothing was changed.');
  assert.deepEqual(fs.readFileSync(lockPath), Buffer.alloc(0));
});

test('a missing home is reported without creating it', async (t) => {
  const homeRoot = path.join(home(t), 'missing');
  const result = await unlock(['--lifecycle'], { homeRoot, inspect: { platform: 'darwin' } });
  assert.equal(result.exitCode, 1);
  assertHeader(result.output, homeRoot, 'file');
  assert.equal(result.output.split('\n')[1],
    `codex-bridge unlock --lifecycle: no package home at ${homeRoot}; nothing to inspect.`);
  assert.equal(fs.existsSync(homeRoot), false);
});

test('current platform reports a free socket and releases the inspection hold', socketOnly, async (t) => {
  const homeRoot = home(t);
  const result = await unlock(['--lifecycle'], { homeRoot });
  assert.equal(result.exitCode, 0);
  assertHeader(result.output, homeRoot, socketStrategy);
  assert.equal(result.output.split('\n')[1], 'free — no install, update or uninstall holds it.');
  assert.deepEqual(fs.readdirSync(homeRoot), []);
  const lock = await acquireLifecycleLock(homeRoot, { command: 'install', hostRoot: homeRoot, waitMs: 0 });
  await lock.release();
});

test('current platform reports a held socket without taking ownership', socketOnly, async (t) => {
  const homeRoot = home(t);
  const hostRoot = path.join(homeRoot, 'host');
  const lock = await acquireLifecycleLock(homeRoot, { command: 'install', hostRoot });
  try {
    const result = await unlock(['--lifecycle'], { homeRoot });
    assert.equal(result.exitCode, 0);
    assertHeader(result.output, homeRoot, socketStrategy);
    assert.ok(result.output.includes(`held by install for ${hostRoot}, pid ${process.pid}, since `));
    assert.doesNotMatch(result.output, /Holder process:|--clear/);
    await assert.rejects(acquireLifecycleLock(homeRoot, { command: 'update', hostRoot, waitMs: 0 }), /held by install/);
  } finally {
    await lock.release();
  }
});

test('a holder arriving after refusal is reported without inventing its identity', async (t) => {
  const homeRoot = home(t);
  const result = await unlock(['--lifecycle'], {
    homeRoot,
    inspect: {
      platform: 'linux',
      createConnection: () => {
        const socket = new EventEmitter();
        socket.destroy = () => {};
        setImmediate(() => socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
        return socket;
      },
      createServer: () => {
        const server = new EventEmitter();
        server.listen = () => setImmediate(() => server.emit('error', Object.assign(new Error('held'), { code: 'EADDRINUSE' })));
        server.close = (callback) => callback();
        return server;
      },
    },
  });
  assert.equal(result.exitCode, 0);
  assertHeader(result.output, homeRoot, 'abstract-socket');
  assert.equal(result.output.split('\n')[1], 'held; the holder did not identify itself.');
  assert.doesNotMatch(result.output, /Holder process:|--clear/);
});

for (const argument of ['alpha', '--all', '--lifecycle', '--unknown', '-h']) {
  test(`lifecycle rejects unexpected argument ${argument} before inspection`, async (t) => {
    const homeRoot = path.join(home(t), 'missing');
    const result = await unlock(['--lifecycle', argument], {
      homeRoot, inspect: { createConnection: () => assert.fail('invalid arguments must not inspect') },
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.output,
      `codex-bridge unlock --lifecycle: unexpected argument "${argument}".\nRun codex-bridge unlock -h for usage.`);
    assert.equal(fs.existsSync(homeRoot), false);
  });
}

test('lifecycle in a later position keeps the existing synchronous parser refusal', () => {
  const result = unlock(['alpha', '--lifecycle']);
  assert.equal(result instanceof Promise, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.output,
    'codex-bridge unlock: unknown option "--lifecycle".\nRun codex-bridge unlock -h for usage.');
});

test('the registry awaits lifecycle inspection and uses the shared brand home resolver', async (t) => {
  const homeRoot = path.join(home(t), 'missing-brand-home');
  const previous = process.env.CODEX_BRIDGE_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BRIDGE_HOME;
    else process.env.CODEX_BRIDGE_HOME = previous;
  });
  process.env.CODEX_BRIDGE_HOME = homeRoot;
  const entry = COMMANDS.find((candidate) => candidate.name === 'unlock');
  assert.deepEqual(entry.usage, ['codex-bridge unlock [<project>|--all]', 'codex-bridge unlock --lifecycle [--clear]']);
  assert.equal(entry.summary, 'Close running records whose runner is gone, or show the lifecycle lock');
  const output = [];
  const exitCode = await entry.handler(['--lifecycle'], { log: (message) => output.push(message) });
  assert.equal(exitCode, 1);
  assert.equal(output.length, 1);
  assertHeader(output[0], homeRoot, socketOnly.skip === false ? socketStrategy : 'file');
  assert.ok(output[0].includes(`no package home at ${homeRoot}; nothing to inspect.`));
  assert.equal(fs.existsSync(homeRoot), false);
});

test('clear removes a dead holder and reports its command, host and pid', async (t) => {
  const homeRoot = home(t);
  const record = holder(homeRoot);
  const lockPath = path.join(homeRoot, '.installed.json.lock');
  fs.writeFileSync(lockPath, JSON.stringify(record) + '\n');
  const result = await unlock(['--lifecycle', '--clear'], {
    homeRoot,
    inspect: { createConnection: () => assert.fail('clear must not inspect a socket') },
    clear: { platform: 'darwin', identity: { kill: () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); } } },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output,
    `Lifecycle lock of ${homeRoot} (file), clearing:\nRemoved the lock left by ${record.command} for ${record.hostRoot}, pid ${record.pid} (dead).
The next install, update or uninstall may take it.`);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(`${lockPath}.clear`), false);
});

test('clear refuses an alive holder with its identity and manual delete instruction', async (t) => {
  const homeRoot = home(t);
  const record = holder(homeRoot);
  const lockPath = path.join(homeRoot, '.installed.json.lock');
  const content = Buffer.from(JSON.stringify(record) + '\n');
  fs.writeFileSync(lockPath, content);
  const result = await unlock(['--lifecycle', '--clear'], {
    homeRoot,
    clear: {
      platform: 'darwin',
      identity: { kill: () => {}, probe: () => Date.parse(record.acquiredAt) - 86_400_000 },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.output,
    `Lifecycle lock of ${homeRoot} (file), clearing:\nRefused: the holder process is alive. Nothing was removed.\nheld by ${record.command} for ${record.hostRoot}, pid ${record.pid}, since ${record.acquiredAt}.\nIf you are sure no install, update or uninstall is running, delete ${lockPath} yourself.`);
  assert.deepEqual(fs.readFileSync(lockPath), content);
});

test('clear reports a kernel-managed Windows lock without creating anything', async (t) => {
  const homeRoot = home(t);
  const result = await unlock(['--lifecycle', '--clear'], { homeRoot, clear: { platform: 'win32' } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output,
    `Lifecycle lock of ${homeRoot} (named-pipe), clearing:\nKernel-managed lock; nothing to clear.
Run codex-bridge unlock --lifecycle to see its holder.`);
  assert.deepEqual(fs.readdirSync(homeRoot), []);
});

test('clear reports a free file lock', async (t) => {
  const homeRoot = home(t);
  const result = await unlock(['--lifecycle', '--clear'], { homeRoot, clear: { platform: 'darwin' } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, `Lifecycle lock of ${homeRoot} (file), clearing:\nNothing to clear; the lock is free.`);
  assert.deepEqual(fs.readdirSync(homeRoot), []);
});

test('clear reports a missing home without creating it', async (t) => {
  const homeRoot = path.join(home(t), 'missing');
  const result = await unlock(['--lifecycle', '--clear'], { homeRoot, clear: { platform: 'darwin' } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.output,
    `Lifecycle lock of ${homeRoot} (file), clearing:\ncodex-bridge unlock --lifecycle: no package home at ${homeRoot}; nothing to inspect.`);
  assert.equal(fs.existsSync(homeRoot), false);
});

test('clear reports an occupied gate and preserves it', async (t) => {
  const homeRoot = home(t);
  const gatePath = path.join(homeRoot, '.installed.json.lock.clear');
  fs.writeFileSync(gatePath, 'crashed clearer');
  const result = await unlock(['--lifecycle', '--clear'], { homeRoot, clear: { platform: 'darwin' } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.output,
    `Lifecycle lock of ${homeRoot} (file), clearing:\nAnother clear is in progress or crashed: ${gatePath}.
If none is running, delete that file yourself.`);
  assert.equal(fs.readFileSync(gatePath, 'utf8'), 'crashed clearer');
});

test('clear refuses an unreadable holder with the manual delete instruction', async (t) => {
  const homeRoot = home(t);
  const lockPath = path.join(homeRoot, '.installed.json.lock');
  fs.writeFileSync(lockPath, '');
  const result = await unlock(['--lifecycle', '--clear'], { homeRoot, clear: { platform: 'darwin' } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.output,
    `Lifecycle lock of ${homeRoot} (file), clearing:\nRefused: holder record is unreadable or incomplete. Nothing was removed.\nIf you are sure no install, update or uninstall is running, delete ${lockPath} yourself.`);
});

test('a leftover gate changes a successful clear exit to failure and names the gate', async (t) => {
  const homeRoot = home(t);
  const record = holder(homeRoot);
  const lockPath = path.join(homeRoot, '.installed.json.lock');
  const gatePath = `${lockPath}.clear`;
  fs.writeFileSync(lockPath, JSON.stringify(record) + '\n');
  const writer = createHomeWriter({ root: homeRoot });
  const result = await unlock(['--lifecycle', '--clear'], {
    homeRoot,
    clear: {
      platform: 'darwin',
      identity: { kill: () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); } },
      writer: {
        ...writer,
        unlink: (id, target) => {
          if (target === gatePath) throw Object.assign(new Error('gate denied'), { code: 'EACCES' });
          return writer.unlink(id, target);
        },
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes('Removed the lock left by '));
  assert.ok(result.output.includes(`Could not remove the clear gate: ${gatePath}.`));
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(gatePath), true);
});

test('duplicate clear is rejected with help before touching the home', async (t) => {
  const homeRoot = path.join(home(t), 'missing');
  const result = await unlock(['--lifecycle', '--clear', '--clear'], { homeRoot });
  assert.equal(result.exitCode, 2);
  assert.equal(result.output,
    'codex-bridge unlock --lifecycle: unexpected argument "--clear".\nRun codex-bridge unlock -h for usage.');
  assert.equal(fs.existsSync(homeRoot), false);
});

test('a refusal names the first argument past --lifecycle --clear', async (t) => {
  const homeRoot = path.join(home(t), 'missing');
  const result = await unlock(['--lifecycle', '--clear', 'extra'], { homeRoot });
  assert.equal(result.exitCode, 2);
  assert.equal(result.output.split('\n')[0], 'codex-bridge unlock --lifecycle: unexpected argument "extra".');
});
