#!/usr/bin/env node
/**
 * Guards the worker's hard wall-clock boundary: streamed output survives it, the invocation
 * tree does not, and a normal early exit keeps its own code.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const realSpawnSync = childProcess.spawnSync;
const taskkillCalls = [];
if (process.platform === 'win32') {
  // The managed test host denies the real taskkill utility. Keep the production call shape,
  // but terminate these fixture PIDs through the same explicit process boundary in-process.
  childProcess.spawnSync = (command, args, options) => {
    if (command !== 'taskkill') return realSpawnSync(command, args, options);
    taskkillCalls.push({ command, args });
    const pids = [Number(args[1])];
    for (const key of ['CODEX_DEADLINE_CODEX_PID', 'CODEX_DEADLINE_PID']) {
      try {
        pids.push(Number(fs.readFileSync(process.env[key], 'utf8')));
      } catch {}
    }
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    return { status: 0, error: null };
  };
  syncBuiltinESMExports();
}
const { runCodex } = await import('../../src/runner/codex-cmd.mjs');
after(() => {
  if (process.platform === 'win32') {
    childProcess.spawnSync = realSpawnSync;
    syncBuiltinESMExports();
  }
});

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, timeout = 2_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

function installFakeCodex(root, source) {
  const bin = path.join(root, 'bin');
  const script = path.join(root, 'fake-codex.mjs');
  fs.mkdirSync(bin);
  fs.writeFileSync(script, source);
  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(bin, 'codex.cmd'),
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
    );
  } else {
    const wrapper = path.join(bin, 'codex');
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
  }
  return bin;
}

async function withFakeCodex(source, work) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-deadline-'));
  const bin = installFakeCodex(root, source);
  const previousPath = process.env.PATH;
  const previousCwd = process.cwd();
  process.env.PATH = [bin, previousPath].filter(Boolean).join(path.delimiter);
  if (process.platform === 'win32') process.chdir(bin);
  try {
    return await work(root);
  } finally {
    if (process.platform === 'win32') process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

test('a deadline kills the invocation tree and records the elapsed stop', async () => {
  await withFakeCodex(
    `import fs from 'node:fs';
import { spawn } from 'node:child_process';

const marker = process.env.CODEX_DEADLINE_MARKER;
fs.writeFileSync(process.env.CODEX_DEADLINE_CODEX_PID, String(process.pid));
if (process.platform === 'win32') {
  const code = 'setTimeout(() => require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "alive"), 1000);';
  const grandchild = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  fs.writeFileSync(process.env.CODEX_DEADLINE_PID, String(grandchild.pid));
} else {
  fs.writeFileSync(process.env.CODEX_DEADLINE_PID, String(process.pid));
}
process.stdout.write('started\\n');
process.stderr.write('transport error\\n');
setInterval(() => {}, 1000);
`,
    async (root) => {
      const logPath = path.join(root, 'raw.log');
      const marker = path.join(root, 'grandchild-alive');
      const pidPath = path.join(root, 'grandchild.pid');
      const codexPidPath = path.join(root, 'codex.pid');
      taskkillCalls.length = 0;
      process.env.CODEX_DEADLINE_MARKER = marker;
      process.env.CODEX_DEADLINE_PID = pidPath;
      process.env.CODEX_DEADLINE_CODEX_PID = codexPidPath;
      try {
        const result = runCodex([], 'deadline test', logPath, 0.01);
        assert.equal(await waitFor(() => fs.existsSync(pidPath)), true);
        const run = await result;
        assert.equal(run.exit, 1);
        assert.equal(run.stoppedOnDeadline, true);
        assert.ok(run.elapsedMs >= 0);
        const pid = Number(fs.readFileSync(pidPath, 'utf8'));
        assert.equal(await waitFor(() => !processAlive(pid)), true);
        await wait(1_100);
        const log = fs.readFileSync(logPath, 'utf8');
        const stderr = fs.readFileSync(path.join(root, 'stderr.log'), 'utf8');
        assert.match(log, /started/);
        assert.match(log, /transport error/);
        assert.equal(stderr, 'transport error\n');
        assert.equal(fs.existsSync(path.join(root, 'stderr.log')), true);
        assert.match(log, /run stopped on its deadline after \d+ ms/);
        assert.equal(fs.existsSync(marker), false);
        if (process.platform === 'win32') {
          assert.equal(taskkillCalls.length, 1);
          assert.equal(taskkillCalls[0].command, 'taskkill');
          assert.match(taskkillCalls[0].args[0], /^\/pid$/i);
          assert.match(taskkillCalls[0].args[1], /^\d+$/);
          assert.deepEqual(taskkillCalls[0].args.slice(2), ['/T', '/F']);
        }
      } finally {
        delete process.env.CODEX_DEADLINE_MARKER;
        delete process.env.CODEX_DEADLINE_PID;
        delete process.env.CODEX_DEADLINE_CODEX_PID;
      }
    },
  );
});

test('an early exit is not replaced by a deadline kill', async () => {
  await withFakeCodex(
    "process.stdout.write('finished early\\n'); process.exit(23);\n",
    async (root) => {
      const logPath = path.join(root, 'raw.log');
      const run = await runCodex([], 'early exit test', logPath, 0.05);
      assert.equal(run.exit, 23);
      assert.equal(run.stoppedOnDeadline, false);
      const log = fs.readFileSync(logPath, 'utf8');
      assert.match(log, /finished early/);
      assert.doesNotMatch(log, /stopped on its deadline/);
      assert.equal(fs.readFileSync(path.join(root, 'stderr.log'), 'utf8'), '');
    },
  );
});
