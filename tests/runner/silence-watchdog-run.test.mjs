/** Plan_80 E16/O3b: watchdog polling observes runs without stealing an earlier stop cause. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const realSpawnSync = childProcess.spawnSync;
const taskkillCalls = [];
let activeRoot;
if (process.platform === 'win32') {
  // As in deadline.test: the managed host denies taskkill. Only fixture PIDs are stopped here.
  childProcess.spawnSync = (command, args, options) => {
    if (command !== 'taskkill') return realSpawnSync(command, args, options);
    taskkillCalls.push(args);
    const ownPid = path.join(activeRoot, 'codex.pid');
    const until = Date.now() + 2000;
    while (!fs.existsSync(ownPid) && Date.now() < until) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const pids = [Number(args[1])];
    for (const file of ['codex.pid', 'grandchild.pid']) {
      const pidFile = path.join(activeRoot, file);
      if (fs.existsSync(pidFile)) pids.push(Number(fs.readFileSync(pidFile, 'utf8')));
    }
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    return { status: 0, error: null };
  };
  syncBuiltinESMExports();
}
const { runCodex } = await import('../../src/home/lib/runner/codex-cmd.mjs');
after(() => {
  childProcess.spawnSync = realSpawnSync;
  syncBuiltinESMExports();
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
async function waitFor(predicate) {
  const until = Date.now() + 2000;
  while (!predicate() && Date.now() < until) await wait(20);
  assert.equal(predicate(), true);
}

async function withFakeCodex(source, work) {
  const root = makeTempTree('silence-watchdog-run-');
  const bin = path.join(root, 'bin');
  const script = path.join(root, 'fake-codex.mjs');
  fs.mkdirSync(bin);
  fs.writeFileSync(script, `import fs from 'node:fs';\nconst root = ${JSON.stringify(root)};\n` +
    `fs.writeFileSync(root + '/codex.pid', String(process.pid));\n` + source);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'codex.cmd'),
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const wrapper = path.join(bin, 'codex');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
  }
  const previousPath = process.env.PATH;
  const previousCwd = process.cwd();
  activeRoot = root;
  taskkillCalls.length = 0;
  process.env.PATH = [bin, previousPath].filter(Boolean).join(path.delimiter);
  if (process.platform === 'win32') process.chdir(bin);
  try {
    return await work(root);
  } finally {
    if (process.platform === 'win32') process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    activeRoot = undefined;
    await removeTempTree(root);
  }
}

function injectedWatchdog(arming, check) {
  const observation = { version: 1, arming, threshold_ms: 996000, interval_ms: 20,
    checks: 0, last_observation: null, decision: null, fault: null };
  return { arming, intervalMs: 20,
    check() {
      observation.checks++;
      const action = check();
      if (action === 'stop') observation.decision = {
        at: '2026-10-17T10:20:00.000Z', silence_ms: 1200000,
        confirmed_at: '2026-10-17T10:20:01.000Z', action: 'stop',
      };
      return action;
    },
    record: () => ({ ...observation }),
  };
}

const longRunning = "fs.writeFileSync(root + '/ready', 'ready'); setInterval(() => {}, 1000);\n";

test('armed stall stops the invocation tree and preserves the watchdog record', async () => {
  await withFakeCodex(`
if (process.platform === 'win32') {
  const { spawn } = await import('node:child_process');
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(root + '/grandchild.pid', String(grandchild.pid));
}
${longRunning}`, async (root) => {
    const watchdog = injectedWatchdog('armed', () => fs.existsSync(path.join(root, 'ready')) ? 'stop' : 'none');
    const run = await runCodex([], 'stall', path.join(root, 'events.jsonl'), 0.1, { watchdog });
    assert.equal(run.stop.trigger, 'silence');
    assert.equal(run.stoppedBySilence, true);
    assert.equal(run.stoppedOnDeadline, false);
    assert.equal(run.stop.tree_stop.requested, true);
    assert.equal(run.stop.tree_stop.state, 'stopped');
    assert.deepEqual(run.watchdog, watchdog.record());
    assert.match(fs.readFileSync(path.join(root, 'stderr.log'), 'utf8'),
      /\nrun-codex: run stopped by the silence watchdog after 1200000 ms without session activity \(threshold 996000 ms\)\n/);
    const checks = run.watchdog.checks;
    await wait(60);
    assert.equal(watchdog.record().checks, checks);
    for (const file of ['codex.pid', ...(process.platform === 'win32' ? ['grandchild.pid'] : [])]) {
      const pid = Number(fs.readFileSync(path.join(root, file), 'utf8'));
      await waitFor(() => !alive(pid));
    }
    if (process.platform === 'win32') {
      assert.equal(taskkillCalls.length, 1);
      assert.deepEqual(taskkillCalls[0].slice(2), ['/T', '/F']);
    }
  });
});

test('shadow polling never stops a Codex that exits on its own', async () => {
  await withFakeCodex("setTimeout(() => process.exit(7), 120);\n", async (root) => {
    const watchdog = injectedWatchdog('shadow', () => 'none');
    const run = await runCodex([], 'shadow', path.join(root, 'events.jsonl'), 0.1, { watchdog });
    assert.equal(run.exit, 7);
    assert.equal(run.stop.trigger, 'exit');
    assert.equal(run.stop.tree_stop.requested, false);
    assert.equal(run.stoppedBySilence, false);
    assert.equal(run.stoppedOnDeadline, false);
    assert.ok(run.watchdog.checks > 0);
    assert.deepEqual(run.watchdog, watchdog.record());
  });
});

test('a shadow run can still be stopped by its deadline', async () => {
  await withFakeCodex(longRunning, async (root) => {
    const watchdog = injectedWatchdog('shadow', () => 'none');
    const run = await runCodex([], 'shadow deadline', path.join(root, 'events.jsonl'), 400 / 60000, { watchdog });
    assert.equal(run.stop.trigger, 'deadline');
    assert.equal(run.stoppedBySilence, false);
    assert.equal(run.stoppedOnDeadline, true);
    assert.ok(run.watchdog.checks > 0);
    const checks = run.watchdog.checks;
    await wait(60);
    assert.equal(watchdog.record().checks, checks);
  });
});

test('a deadline before the first poll wins even when the watchdog would stop', async () => {
  await withFakeCodex(longRunning, async (root) => {
    const watchdog = injectedWatchdog('armed', () => 'stop');
    const run = await runCodex([], 'deadline first', path.join(root, 'events.jsonl'), 1 / 60000, { watchdog });
    assert.equal(run.stop.trigger, 'deadline');
    assert.equal(run.stoppedBySilence, false);
    assert.equal(run.stoppedOnDeadline, true);
    assert.equal(run.watchdog.checks, 0);
    await wait(60);
    assert.equal(watchdog.record().checks, 0);
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'stderr.log'), 'utf8'), /silence watchdog/);
  });
});

test('a Codex exit clears polling while its pipes are still draining', async (t) => {
  const root = makeTempTree('silence-watchdog-exit-');
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => assert.fail('an exited Codex must not be stopped');
  t.mock.method(childProcess, 'spawn', () => child);
  t.mock.method(childProcess, 'spawnSync', () => assert.fail('an exited Codex must not be stopped'));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const watchdog = injectedWatchdog('armed', () => 'stop');
  const pending = runCodex([], 'exit first', path.join(root, 'events.jsonl'), null,
    { watchdog, graceMs: 1000 });
  child.emit('exit', 0, null);
  await wait(60);
  assert.equal(watchdog.record().checks, 0);
  child.stdout.end();
  child.stderr.end();
  child.emit('close', 0);
  const run = await pending;
  assert.equal(run.stop.trigger, 'exit');
  assert.equal(run.stop.tree_stop.requested, false);
  assert.equal(run.stoppedBySilence, false);
  assert.equal(run.stoppedOnDeadline, false);
});

test('no watchdog preserves normal exit and returns a null watchdog record', async () => {
  await withFakeCodex('process.exit(3);\n', async (root) => {
    const run = await runCodex([], 'no watchdog', path.join(root, 'events.jsonl'), 0.1);
    assert.equal(run.exit, 3);
    assert.equal(run.watchdog, null);
    assert.equal(run.stoppedBySilence, false);
    assert.equal(run.stoppedOnDeadline, false);
    assert.equal(run.stop.trigger, 'exit');
    assert.equal(run.stop.tree_stop.requested, false);
  });
});

for (const intervalMs of [null, 0, -20, '20']) {
  test(`an inactive watchdog interval ${JSON.stringify(intervalMs)} does not poll`, async () => {
    await withFakeCodex('process.exit(0);\n', async (root) => {
      const watchdog = { ...injectedWatchdog('off', () => assert.fail('inactive polling')), intervalMs };
      const run = await runCodex([], 'off', path.join(root, 'events.jsonl'), 0.1, { watchdog });
      assert.equal(run.stoppedBySilence, false);
      assert.equal(run.watchdog.checks, 0);
      assert.deepEqual(run.watchdog, watchdog.record());
    });
  });
}
