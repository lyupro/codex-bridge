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
    // The real /T flag walks the process tree at kill time; this stand-in can only read pids a
    // fixture wrote down. A kill triggered within milliseconds of spawn (a stream that failed to
    // open) arrives before the fixture has written its file, so the wait is what keeps the
    // stand-in honest — without it the grandchild survives here and nowhere else.
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    for (const key of ['CODEX_DEADLINE_CODEX_PID', 'CODEX_DEADLINE_PID']) {
      const file = process.env[key];
      if (!file) continue;
      const until = Date.now() + 2_000;
      for (;;) {
        try {
          pids.push(Number(fs.readFileSync(file, 'utf8')));
          break;
        } catch {
          if (Date.now() >= until) break;
          sleep(25);
        }
      }
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
      const eventsPath = path.join(root, 'events.jsonl');
      const marker = path.join(root, 'grandchild-alive');
      const pidPath = path.join(root, 'grandchild.pid');
      const codexPidPath = path.join(root, 'codex.pid');
      taskkillCalls.length = 0;
      process.env.CODEX_DEADLINE_MARKER = marker;
      process.env.CODEX_DEADLINE_PID = pidPath;
      process.env.CODEX_DEADLINE_CODEX_PID = codexPidPath;
      try {
        const result = runCodex([], 'deadline test', eventsPath, 0.01);
        assert.equal(await waitFor(() => fs.existsSync(pidPath)), true);
        const run = await result;
        assert.equal(run.exit, 1);
        assert.equal(run.stoppedOnDeadline, true);
        assert.ok(run.elapsedMs >= 0);
        const pid = Number(fs.readFileSync(pidPath, 'utf8'));
        assert.equal(await waitFor(() => !processAlive(pid)), true);
        await wait(1_100);
        const events = fs.readFileSync(eventsPath, 'utf8');
        const stderr = fs.readFileSync(path.join(root, 'stderr.log'), 'utf8');
        assert.match(events, /started/);
        assert.doesNotMatch(events, /transport error/);
        assert.match(stderr, /transport error/);
        assert.match(stderr, /run stopped on its deadline after \d+ ms/);
        assert.equal(fs.existsSync(path.join(root, 'stderr.log')), true);
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
      const eventsPath = path.join(root, 'events.jsonl');
      const run = await runCodex([], 'early exit test', eventsPath, 0.05);
      assert.equal(run.exit, 23);
      assert.equal(run.stoppedOnDeadline, false);
      const events = fs.readFileSync(eventsPath, 'utf8');
      assert.match(events, /finished early/);
      assert.doesNotMatch(events, /stopped on its deadline/);
      assert.equal(fs.readFileSync(path.join(root, 'stderr.log'), 'utf8'), '');
    },
  );
});

// A process can be gone while its stdio is not: a detached grandchild holds the pipes open, so
// 'close' arrives late. Judging the deadline by 'close' would brand an honest early exit as a
// run the runner killed — and that claim is now what the verdict trusts.
test('a run that exited before its deadline is not marked as stopped by it', async () => {
  await withFakeCodex(
    `import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], {
  detached: true,
  stdio: 'inherit',
});
child.unref();
process.stdout.write('parent done\\n');
process.exit(7);
`,
    async (root) => {
      const eventsPath = path.join(root, 'events.jsonl');
      const started = Date.now();
      // 250ms stands in for the production grace: the fallback is what is under test, not how
      // long a real run waits for its pipes. The default is deliberately far larger, because
      // cutting stdio early loses the tail of events.jsonl that carries the run's own result.
      const run = await runCodex([], 'late close test', eventsPath, 0.02, 250);
      assert.ok(Date.now() - started < 2_000);
      assert.equal(run.exit, 7);
      assert.equal(run.stoppedOnDeadline, false);
      assert.equal(run.stdioDrained, false);
      assert.doesNotMatch(fs.readFileSync(eventsPath, 'utf8'), /stopped on its deadline/);
      // The fixture grandchild intentionally keeps the inherited Windows cwd open; let it
      // finish so cleanup can remove the temporary tree after proving the run closed early.
      await wait(3_100);
    },
  );
});

// The orphan of 2026-07-31 with one more step in front of it: an unopenable log file throws a
// stream 'error' the worker does not survive, the crash handler closes the folder, and Codex
// keeps spending quota with nobody watching. The run must die WITH its child.
test('a log file that cannot be opened stops Codex instead of orphaning it', async () => {
  await withFakeCodex(
    `import fs from 'node:fs';

fs.writeFileSync(process.env.CODEX_DEADLINE_CODEX_PID, String(process.pid));
if (process.platform === 'win32') {
  fs.writeFileSync(process.env.CODEX_DEADLINE_PID, String(process.pid));
}
process.stdout.write('started\\n');
// The failure surfaces on the first write, not on open: a run whose stderr stays silent never
// touches the broken file at all.
process.stderr.write('transport noise\\n');
setInterval(() => {}, 1000);
`,
    async (root) => {
      const eventsPath = path.join(root, 'events.jsonl');
      const pidPath = path.join(root, 'codex.pid');
      // A directory where the file belongs: createWriteStream fails with EISDIR, which is the
      // same event shape as a permission or disk failure and needs no privileges to stage.
      fs.mkdirSync(path.join(root, 'stderr.log'));
      process.env.CODEX_DEADLINE_CODEX_PID = pidPath;
      process.env.CODEX_DEADLINE_PID = path.join(root, 'shell.pid');
      try {
        // A short budget on purpose: if the stream failure stops stopping Codex, this test must
        // fail in seconds rather than hang the suite until a realistic deadline expires.
        const run = await runCodex([], 'stderr failure test', eventsPath, 0.25);
        assert.equal(run.exit, 1);
        assert.equal(run.stoppedOnDeadline, false);
        const pid = Number(fs.readFileSync(pidPath, 'utf8'));
        assert.equal(await waitFor(() => !processAlive(pid)), true);
      } finally {
        delete process.env.CODEX_DEADLINE_CODEX_PID;
        delete process.env.CODEX_DEADLINE_PID;
      }
    },
  );
});
