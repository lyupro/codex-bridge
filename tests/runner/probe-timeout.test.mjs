/**
 * Plan_57 D24: probe deadlines must reap the Windows tree, not repeat the 2026-07-31 orphan.
 * Fixtures and mocked process events exercise capture and bounded settlement without real Codex.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnCaptured } from '../../src/home/lib/runner/codex-cmd.mjs';
import { probeSandbox } from '../../src/home/lib/runner/sandbox-probe.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

test('spawnCaptured returns the exit code and separate UTF-8 output streams', async () => {
  const result = await spawnCaptured(process.execPath, ['-e',
    "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3",
  ], { timeout: 5_000 });
  assert.deepEqual(result, { status: 3, signal: null, error: null, stdout: 'out', stderr: 'err' });
});

test('spawnCaptured reports ENOENT for an absolute missing executable', async (t) => {
  const root = makeTempTree('probe-missing-');
  t.after(() => removeTempTree(root));
  const result = await spawnCaptured(path.join(root, 'missing.exe'), [], { timeout: 5_000 });
  assert.equal(result.error.code, 'ENOENT');
  assert.equal(result.status, null);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('spawnCaptured rejects missing, non-finite and non-positive timeouts before spawning', async (t) => {
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    assert.fail('an invalid deadline must never start a process');
  });
  syncBuiltinESMExports();
  try {
    for (const options of [undefined, {}, ...[0, -1, NaN, Infinity, -Infinity, '500', null]
      .map((timeout) => ({ timeout }))]) {
      await assert.rejects(async () => spawnCaptured(process.execPath, [], options), TypeError);
    }
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('spawnCaptured stops a hanging process and settles within ten seconds', { timeout: 12_000 }, async () => {
  const started = performance.now();
  const result = await spawnCaptured(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 500 });
  assert.equal(result.error.code, 'ETIMEDOUT');
  assert.equal(result.error.message, 'timed out after 500 ms');
  assert.ok(performance.now() - started < 10_000, 'the deadline must bound the capture promise');
});

// Synthetic events make the missing-exit fallback deterministic without leaving a real process behind.
async function withCapturedChild(t, work) {
  const child = new EventEmitter();
  child.pid = 424242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = t.mock.fn(() => true);
  const spawn = t.mock.method(childProcess, 'spawn', () => child);
  const stop = t.mock.method(childProcess, 'spawnSync', () => ({ status: 0 }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  syncBuiltinESMExports();
  try {
    await work({ child, spawn, stop });
  } finally {
    t.mock.timers.reset();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

test('spawnCaptured forwards process options but omits shell, timeout and encoding', async (t) => {
  await withCapturedChild(t, async ({ child, spawn }) => {
    const env = { FIXTURE: 'capture' };
    const pending = spawnCaptured('fixture', ['arg'], {
      timeout: 500, cwd: 'fixture-repo', env, windowsHide: true, windowsVerbatimArguments: true,
      encoding: 'hex', shell: true, stdio: 'inherit',
    });
    assert.deepEqual(spawn.mock.calls[0].arguments, ['fixture', ['arg'], {
      cwd: 'fixture-repo', env, windowsHide: true, windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }]);
    child.stdout.write(Buffer.from('caf\u00e9'));
    child.stderr.write(Buffer.from('\u03bb'));
    child.emit('close', 0, null);
    assert.deepEqual(await pending, { status: 0, signal: null, error: null, stdout: 'caf\u00e9', stderr: '\u03bb' });
  });
});

test('spawnCaptured keeps the first 64 KiB of stdout and last 64 KiB of stderr', async (t) => {
  await withCapturedChild(t, async ({ child }) => {
    const pending = spawnCaptured('fixture', [], { timeout: 500 });
    const limit = 64 * 1024;
    const output = 'codex-bridge-sandbox-ok\n' + 'x'.repeat(limit * 2) + 'stdout tail';
    const error = 'stderr head' + 'y'.repeat(limit * 2) + 'latest error';
    for (let index = 0; index < output.length; index += 997) child.stdout.write(output.slice(index, index + 997));
    for (let index = 0; index < error.length; index += 991) child.stderr.write(error.slice(index, index + 991));
    child.emit('close', 1, null);
    const result = await pending;
    assert.equal(result.stdout, output.slice(0, limit));
    assert.equal(result.stderr, error.slice(-limit));
  });
});

test('spawnCaptured gives inherited pipes two seconds after exit then preserves code and signal', async (t) => {
  await withCapturedChild(t, async ({ child, stop }) => {
    let settled = false;
    const pending = spawnCaptured('fixture', [], { timeout: 500 }).then((result) => { settled = true; return result; });
    child.stdout.write('before exit');
    child.emit('exit', null, 'SIGTERM');
    t.mock.timers.tick(1_999);
    await Promise.resolve();
    assert.equal(settled, false);
    child.stderr.write('drained after exit');
    t.mock.timers.tick(1);
    assert.deepEqual(await pending, {
      status: null, signal: 'SIGTERM', error: null, stdout: 'before exit', stderr: 'drained after exit',
    });
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.equal(stop.mock.callCount(), 0);
    assert.equal(child.kill.mock.callCount(), 0);
  });
});

test('spawnCaptured clears the deadline and exit grace when close arrives', async (t) => {
  await withCapturedChild(t, async ({ child, stop }) => {
    const pending = spawnCaptured('fixture', [], { timeout: 500 });
    child.emit('exit', 3, null);
    child.stdout.write('drained');
    child.emit('close', 3, null);
    assert.deepEqual(await pending, { status: 3, signal: null, error: null, stdout: 'drained', stderr: '' });
    child.emit('exit', 9, null);
    t.mock.timers.tick(60_000);
    assert.equal(child.stdout.destroyed, false);
    assert.equal(child.stderr.destroyed, false);
    assert.equal(stop.mock.callCount(), 0);
    assert.equal(child.kill.mock.callCount(), 0);
  });
});

test('spawnCaptured settles once on spawn error and ignores later close and exit', async (t) => {
  await withCapturedChild(t, async ({ child, stop }) => {
    const pending = spawnCaptured('fixture', [], { timeout: 500 });
    const error = Object.assign(new Error('missing executable'), { code: 'ENOENT' });
    child.emit('error', error);
    child.emit('close', -2, null);
    child.emit('exit', -2, null);
    t.mock.timers.tick(60_000);
    assert.deepEqual(await pending, { status: null, signal: null, error, stdout: '', stderr: '' });
    assert.equal(stop.mock.callCount(), 0);
    assert.equal(child.kill.mock.callCount(), 0);
  });
});

for (const closes of [false, true]) {
  test(`spawnCaptured retains timeout evidence after exit with close=${closes}`, async (t) => {
    await withCapturedChild(t, async ({ child }) => {
      const pending = spawnCaptured('fixture', [], { timeout: 500 });
      t.mock.timers.tick(500);
      child.emit('exit', null, 'SIGKILL');
      if (closes) child.emit('close', null, 'SIGKILL');
      else t.mock.timers.tick(2_000);
      const result = await pending;
      assert.equal(result.status, null);
      assert.equal(result.signal, 'SIGKILL');
      assert.equal(result.error.code, 'ETIMEDOUT');
      assert.equal(result.error.message, 'timed out after 500 ms');
      t.mock.timers.tick(60_000);
      assert.equal(child.stdout.destroyed, !closes);
      assert.equal(child.stderr.destroyed, !closes);
    });
  });
}

test('spawnCaptured settles five seconds after stopping even without exit or close', async (t) => {
  await withCapturedChild(t, async ({ child, stop }) => {
    let settlements = 0;
    const pending = spawnCaptured('fixture', [], { timeout: 500 }).then((result) => { settlements += 1; return result; });
    t.mock.timers.tick(500);
    if (process.platform === 'win32') {
      assert.deepEqual(stop.mock.calls[0].arguments, ['taskkill', ['/pid', '424242', '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      }]);
    } else {
      assert.deepEqual(child.kill.mock.calls[0].arguments, ['SIGKILL']);
    }
    t.mock.timers.tick(4_999);
    await Promise.resolve();
    assert.equal(settlements, 0);
    t.mock.timers.tick(1);
    const result = await pending;
    assert.equal(result.status, null);
    assert.equal(result.signal, null);
    assert.equal(result.error.code, 'ETIMEDOUT');
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    child.emit('error', new Error('late error'));
    t.mock.timers.tick(60_000);
    await Promise.resolve();
    assert.equal(settlements, 1);
  });
});

test('a Windows probe timeout kills the fake Codex grandchild and stops after flagged', { timeout: 22_000 }, async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows cmd.exe and taskkill /T process-tree regression');
  const root = makeTempTree('probe-tree-');
  const bin = path.join(root, 'bin');
  const script = path.join(root, 'fake-codex.mjs');
  const pidFile = path.join(root, 'grandchild.pid');
  const parentPidFile = path.join(root, 'fake-codex.pid');
  let pid;
  t.after(async () => {
    try {
      // A restricted host may deny taskkill: still reap both fixture-owned Node processes directly.
      const cleanupPids = [pid ?? (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null),
        fs.existsSync(parentPidFile) ? Number(fs.readFileSync(parentPidFile, 'utf8')) : null];
      for (const cleanupPid of cleanupPids.filter((value) => Number.isInteger(value) && value > 0)) {
        const cleanup = childProcess.spawnSync('taskkill', ['/pid', String(cleanupPid), '/T', '/F'], {
          stdio: 'ignore', windowsHide: true, timeout: 5_000,
        });
        if (cleanup.error || cleanup.status !== 0) {
          try { process.kill(cleanupPid, 'SIGKILL'); } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
      }
    } finally {
      await removeTempTree(root);
    }
  });
  fs.mkdirSync(bin);
  fs.writeFileSync(script, `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
fs.writeFileSync(new URL('./fake-codex.pid', import.meta.url), String(process.pid));
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
fs.writeFileSync(new URL('./grandchild.pid', import.meta.url), String(child.pid));
setInterval(() => {}, 1000);
`);
  fs.writeFileSync(path.join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const originalPath = process.env.PATH;
  let result;
  const started = performance.now();
  try {
    process.env.PATH = [bin, originalPath].filter(Boolean).join(path.delimiter);
    result = await probeSandbox({ agent: 'codex-scout', repo: root, platform: 'win32', timeoutMs: 2_000 });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  assert.ok(performance.now() - started < 15_000, 'the probe must settle within fifteen seconds');
  assert.equal(result.outcome, 'inconclusive');
  assert.match(result.reason, /timed out/);
  assert.deepEqual(result.attempts.map(({ form }) => form), ['flagged']);
  pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 0, 'the fake Codex must have spawned its grandchild');
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal(error.code, 'ESRCH');
      return;
    }
    await delay(50);
  }
  assert.fail(`grandchild ${pid} survived the probe timeout`);
});
