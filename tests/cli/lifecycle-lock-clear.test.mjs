/** Plan_65 D8/D11/A14: clearing preserves live holders and serializes authoritative reads. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { clearLifecycleLock } from '../../cli/lifecycle-lock-clear.mjs';
import { createHomeWriter } from '../../src/home/lib/home-write.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const dead = { kill: () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); } };

function fixture(t) {
  const homeRoot = makeTempTree('lifecycle-clear-');
  t.after(() => removeTempTree(homeRoot));
  const lockPath = path.join(homeRoot, '.installed.json.lock');
  const gatePath = `${lockPath}.clear`;
  const holder = {
    pid: process.pid, command: 'update', hostRoot: path.join(homeRoot, 'host'),
    acquiredAt: '2026-09-30T08:00:00.000Z', token: 'crashed-holder',
  };
  const content = Buffer.from(JSON.stringify(holder) + '\r\nignored second line\r\n');
  return { homeRoot, lockPath, gatePath, holder, content };
}

function clear(homeRoot, options = {}) {
  return clearLifecycleLock(homeRoot, { platform: 'darwin', identity: dead, ...options });
}

function assertBase(result, homeRoot, strategy = 'file') {
  assert.equal(result.homeRoot, homeRoot);
  assert.equal(result.strategy, strategy);
  if (strategy === 'file') assert.equal(result.lockPath, path.join(homeRoot, '.installed.json.lock'));
}

test('dead holder is cleared through the home writer and the gate is released', async (t) => {
  const { homeRoot, lockPath, gatePath, holder, content } = fixture(t);
  fs.writeFileSync(lockPath, content);
  const writer = createHomeWriter({ root: homeRoot });
  const calls = [];
  const result = await clear(homeRoot, {
    writer: {
      open: async (...args) => { calls.push(['open', ...args]); return writer.open(...args); },
      unlink: async (...args) => { calls.push(['unlink', ...args]); return writer.unlink(...args); },
    },
    identity: {
      kill: () => {
        const gate = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
        assert.equal(gate.pid, process.pid);
        assert.equal(new Date(gate.startedAt).toISOString(), gate.startedAt);
        dead.kill();
      },
    },
  });
  assertBase(result, homeRoot);
  assert.equal(result.outcome, 'cleared');
  assert.deepEqual(result.holder, holder);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(gatePath), false);
  assert.deepEqual(calls, [
    ['open', 'install-record', gatePath, 'wx'],
    ['unlink', 'install-record', lockPath],
    ['unlink', 'install-record', gatePath],
  ]);
});

for (const [liveness, probe] of [
  ['alive', () => Date.parse('2026-09-30T08:00:00.000Z') - 86_400_000],
  ['unverified', () => null],
  ['foreign', () => Date.parse('2026-09-30T08:00:00.000Z') + 86_400_000],
]) {
  test(`${liveness} holder is refused with byte-for-byte preservation`, async (t) => {
    const { homeRoot, lockPath, gatePath, holder, content } = fixture(t);
    fs.writeFileSync(lockPath, content);
    const result = await clear(homeRoot, { identity: { kill: () => {}, probe } });
    assertBase(result, homeRoot);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.reason, `the holder process is ${liveness}`);
    assert.deepEqual(result.holder, holder);
    assert.deepEqual(fs.readFileSync(lockPath), content);
    assert.equal(fs.existsSync(gatePath), false);
  });
}

for (const [label, record] of [
  ['empty', () => ''],
  ['malformed', () => '{not-json}\n'],
  ['zero pid', (holder) => JSON.stringify({ ...holder, pid: 0 }) + '\n'],
  ['incomplete', (holder) => JSON.stringify({ pid: holder.pid }) + '\n'],
]) {
  test(`${label} holder record is refused unchanged`, async (t) => {
    const { homeRoot, lockPath, gatePath, holder } = fixture(t);
    const content = Buffer.from(record(holder));
    fs.writeFileSync(lockPath, content);
    const result = await clear(homeRoot);
    assertBase(result, homeRoot);
    assert.equal(result.outcome, 'refused');
    assert.equal(result.reason, 'holder record is unreadable or incomplete');
    assert.deepEqual(fs.readFileSync(lockPath), content);
    assert.equal(fs.existsSync(gatePath), false);
  });
}

test('pre-existing gate is never removed and prevents reading the holder', async (t) => {
  const { homeRoot, lockPath, gatePath, content } = fixture(t);
  fs.writeFileSync(lockPath, content);
  const gate = Buffer.from('crashed clearer\n');
  fs.writeFileSync(gatePath, gate);
  const result = await clear(homeRoot, { identity: { kill: () => assert.fail('gate must precede holder read') } });
  assertBase(result, homeRoot);
  assert.equal(result.outcome, 'gate-busy');
  assert.equal(result.gatePath, gatePath);
  assert.deepEqual(fs.readFileSync(lockPath), content);
  assert.deepEqual(fs.readFileSync(gatePath), gate);
});

test('directory at the lock path is refused and remains present', async (t) => {
  const { homeRoot, lockPath, gatePath } = fixture(t);
  fs.mkdirSync(lockPath);
  const result = await clear(homeRoot);
  assertBase(result, homeRoot);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'not a regular file');
  assert.ok(fs.lstatSync(lockPath).isDirectory());
  assert.equal(fs.existsSync(gatePath), false);
});

test('link at the lock path is refused without following or removing it', async (t) => {
  const { homeRoot, lockPath, gatePath } = fixture(t);
  const target = path.join(homeRoot, 'target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, lockPath, 'junction');
  const result = await clear(homeRoot);
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'not a regular file');
  assert.ok(fs.lstatSync(lockPath).isSymbolicLink());
  assert.ok(fs.existsSync(target));
  assert.equal(fs.existsSync(gatePath), false);
});

test('absent lock is free with no gate left', async (t) => {
  const { homeRoot, gatePath } = fixture(t);
  const result = await clear(homeRoot);
  assertBase(result, homeRoot);
  assert.equal(result.outcome, 'free');
  assert.equal(fs.existsSync(gatePath), false);
  assert.deepEqual(fs.readdirSync(homeRoot), []);
});

for (const [platform, strategy] of [['win32', 'named-pipe'], ['linux', 'abstract-socket']]) {
  test(`${platform} is kernel-managed without creating or removing files`, async (t) => {
    const { homeRoot, lockPath, gatePath, content } = fixture(t);
    fs.writeFileSync(lockPath, content);
    fs.writeFileSync(gatePath, 'leave this gate');
    const result = await clear(homeRoot, {
      platform,
      writer: { open: () => assert.fail('kernel strategy must not write') },
    });
    assertBase(result, homeRoot, strategy);
    assert.equal(result.outcome, 'kernel-managed');
    assert.deepEqual(fs.readFileSync(lockPath), content);
    assert.equal(fs.readFileSync(gatePath, 'utf8'), 'leave this gate');
    assert.deepEqual(fs.readdirSync(homeRoot).sort(), ['.installed.json.lock', '.installed.json.lock.clear']);
  });
}

for (const platform of ['darwin', 'win32']) {
  test(`missing home on ${platform} is not created`, async (t) => {
    const { homeRoot } = fixture(t);
    const missing = path.join(homeRoot, 'missing');
    const result = await clear(missing, { platform });
    assertBase(result, missing, platform === 'darwin' ? 'file' : 'named-pipe');
    assert.equal(result.outcome, 'no-home');
    assert.equal(fs.existsSync(missing), false);
  });
}

test('replacement holder between reads is refused and its lock is preserved', async (t) => {
  const { homeRoot, lockPath, gatePath, holder, content } = fixture(t);
  fs.writeFileSync(lockPath, content);
  const replacement = Buffer.from(JSON.stringify({ ...holder, pid: holder.pid + 1, token: 'new-holder' }) + '\n');
  const result = await clear(homeRoot, {
    identity: {
      kill: () => {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, replacement);
        dead.kill();
      },
    },
  });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'the lock changed while clearing');
  assert.deepEqual(fs.readFileSync(lockPath), replacement);
  assert.equal(fs.existsSync(gatePath), false);
});

test('metadata change with identical content is refused', async (t) => {
  const { homeRoot, lockPath, content } = fixture(t);
  fs.writeFileSync(lockPath, content);
  const result = await clear(homeRoot, {
    identity: {
      kill: () => {
        const changedTime = new Date(fs.statSync(lockPath).mtimeMs + 60_000);
        fs.utimesSync(lockPath, changedTime, changedTime);
        dead.kill();
      },
    },
  });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'the lock changed while clearing');
  assert.deepEqual(fs.readFileSync(lockPath), content);
});

test('second clearer cannot read a holder while the first owns the gate', async (t) => {
  const { homeRoot, lockPath, gatePath, content } = fixture(t);
  fs.writeFileSync(lockPath, content);
  const writer = createHomeWriter({ root: homeRoot });
  let second;
  const first = await clear(homeRoot, {
    writer: {
      ...writer,
      open: async (...args) => {
        const handle = await writer.open(...args);
        return {
          writeFile: async (line) => {
            await handle.writeFile(line);
            second = await clear(homeRoot, {
              identity: { kill: () => assert.fail('second clearer must not inspect the holder') },
            });
          },
          close: () => handle.close(),
        };
      },
    },
  });
  assert.equal(second.outcome, 'gate-busy');
  assert.equal(second.gatePath, gatePath);
  assert.equal(first.outcome, 'cleared');
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(gatePath), false);
});

test('gate unlink failure is reported even after a successful clear', async (t) => {
  const { homeRoot, lockPath, gatePath, content } = fixture(t);
  fs.writeFileSync(lockPath, content);
  const writer = createHomeWriter({ root: homeRoot });
  const result = await clear(homeRoot, {
    writer: {
      ...writer,
      unlink: (id, target) => {
        if (target === gatePath) throw Object.assign(new Error('gate denied'), { code: 'EACCES' });
        return writer.unlink(id, target);
      },
    },
  });
  assert.equal(result.outcome, 'cleared');
  assert.equal(result.gateLeft, gatePath);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(gatePath), true);
});

test('lock unlink failure refuses and still releases the gate', async (t) => {
  const { homeRoot, lockPath, gatePath, content } = fixture(t);
  fs.writeFileSync(lockPath, content);
  const writer = createHomeWriter({ root: homeRoot });
  const result = await clear(homeRoot, {
    writer: {
      ...writer,
      unlink: (id, target) => {
        if (target === lockPath) throw Object.assign(new Error('lock denied'), { code: 'EACCES' });
        return writer.unlink(id, target);
      },
    },
  });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'EACCES');
  assert.deepEqual(fs.readFileSync(lockPath), content);
  assert.equal(fs.existsSync(gatePath), false);
});

test('failed gate write returns a refusal and releases its owned gate', async (t) => {
  const { homeRoot, lockPath, gatePath, content } = fixture(t);
  fs.writeFileSync(lockPath, content);
  const writer = createHomeWriter({ root: homeRoot });
  const result = await clear(homeRoot, {
    writer: {
      ...writer,
      open: async (...args) => {
        const handle = await writer.open(...args);
        return {
          writeFile: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
          close: () => handle.close(),
        };
      },
    },
  });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.reason, 'ENOSPC');
  assert.deepEqual(fs.readFileSync(lockPath), content);
  assert.equal(fs.existsSync(gatePath), false);
});

test('a gate that fails to close never turns a removed lock into a refusal', async (t) => {
  const { homeRoot, lockPath, gatePath, content } = fixture(t);
  fs.writeFileSync(lockPath, content);
  const writer = createHomeWriter({ root: homeRoot });
  const result = await clear(homeRoot, {
    writer: {
      ...writer,
      open: async (...args) => {
        const handle = await writer.open(...args);
        return {
          writeFile: (data) => handle.writeFile(data),
          close: async () => {
            await handle.close();
            throw Object.assign(new Error('close failed'), { code: 'EIO' });
          },
        };
      },
    },
  });
  assert.equal(result.outcome, 'cleared');
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(gatePath), false);
});
