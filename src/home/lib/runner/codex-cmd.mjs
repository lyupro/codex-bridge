/**
 * Invoking the `codex` CLI: starting it, stopping its whole tree, telling whether it is there at
 * all, and keeping its JSONL stdout in events.jsonl while stderr stays separate.
 *
 * Which flags a run gets is the neighbouring codex-args.mjs: this file starts the process and
 * stops it, and knows nothing about what the arguments mean. The two were one module until it
 * outgrew the size limit, and the seam is the honest one — "how we run Codex" against "what we
 * ask it to run".
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHeartbeat, HEARTBEAT_INTERVAL_MS } from '../heartbeat.mjs';
import { writeFailure } from '../write-meta.mjs';
import { MAX_LOG } from './git-state.mjs';

// Thirty seconds, not a fraction of one: after `exit` the pipe still holds whatever Codex wrote
// last, and that tail carries `item.completed` — the result the verdict is read from. A quarter
// of a second is enough to lose it on a loaded Windows host, turning a finished run into "the run
// left no event". The grace exists to bound a grandchild holding stdio open forever (2026-08-06,
// run 2026-08-06_204007_build waited 25 minutes), and thirty seconds bounds that just as well.
const STDIO_DRAIN_GRACE_MS = 30_000;

/**
 * An argument cmd.exe cannot be handed safely, or undefined. `%` is fatal because cmd
 * expands variables even inside quotes. The launcher asks first, so the refusal costs
 * nothing; the worker asks again on its own copy, because a process whose stderr goes
 * nowhere must not be the one to discover this.
 */
export const unsafeForCmd = (args) =>
  ['codex', ...args].find((a) => a.includes('%') || a.includes('"'));

/**
 * Stop the process that owns the Codex invocation. On Windows that process is cmd.exe, so
 * child.kill() would reap only the shell and leave Codex spending quota as its grandchild —
 * the exact orphan left by the killed caller on 2026-07-31. taskkill's tree flag is required;
 * POSIX has no shell wrapper here, so killing the child itself is the honest boundary.
 */
export function stopCodex(child, onWindows = process.platform === 'win32') {
  if (!onWindows) {
    child.kill('SIGKILL');
    return;
  }
  const killed = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (killed.error || killed.status !== 0) child.kill();
}

/**
 * Windows npm ships `codex` as codex.cmd, and Node refuses to spawn .cmd without a
 * shell. One command line through cmd.exe keeps a single code path; every argument is
 * quoted here, and unsafeForCmd() has already refused the ones that cannot be.
 *
 * Stdout is streamed, not collected: spawnSync kept every byte in memory and wrote the file
 * only on return, so a worker killed at minute twelve left events.jsonl missing entirely and
 * the run became unexplainable (2026-07-31, run 114736). Now whatever Codex has already said
 * is on disk, and the task text is pushed into stdin by hand since there is no `input` option
 * outside spawnSync. MAX_LOG stays the ceiling; past it the stream is cut rather than the run
 * being killed — a huge stream is a diagnosis, not a reason to lose the work. stderr has its
 * own bounded file because text outside the JSONL protocol must remain distinguishable from
 * protocol events, and a line cut in half cannot be parsed back safely.
 */
export function runCodex(args, taskText, eventsPath, budgetMinutes, graceMs = STDIO_DRAIN_GRACE_MS) {
  const onWindows = process.platform === 'win32';
  const deadlineMs =
    typeof budgetMinutes === 'number' && Number.isFinite(budgetMinutes) && budgetMinutes > 0
      ? budgetMinutes * 60 * 1000
      : null;
  let exited = false;
  const heartbeat = createHeartbeat(path.dirname(eventsPath));
  const stampHeartbeat = () => {
    if (!exited) heartbeat.stamp();
  };
  const stderrLog = fs.createWriteStream(path.join(path.dirname(eventsPath), 'stderr.log'), { flags: 'a' });
  const eventsLog = fs.createWriteStream(eventsPath, { flags: 'a' });
  const appendTo = (stream, label) => {
    let written = 0;
    let cut = false;
    return (chunk) => {
      stampHeartbeat();
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (written >= MAX_LOG) {
        if (!cut) {
          cut = true;
          stream.write(`\nrun-codex: ${label} truncated at ${MAX_LOG} bytes; further output is not saved\n`);
        }
        return;
      }
      const room = MAX_LOG - written;
      const slice = buf.length > room ? buf.subarray(0, room) : buf;
      written += slice.length;
      stream.write(slice);
    };
  };
  const appendStderr = appendTo(stderrLog, 'stderr log');
  const appendEvents = (() => {
    let pending = Buffer.alloc(0);
    let written = 0;
    let cut = false;
    const append = (chunk) => {
      stampHeartbeat();
      if (cut) return;
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      pending = pending.length ? Buffer.concat([pending, incoming]) : incoming;
      let newline = pending.indexOf(0x0a);
      while (newline !== -1) {
        const line = pending.subarray(0, newline + 1);
        pending = pending.subarray(newline + 1);
        if (written + line.length > MAX_LOG) {
          cut = true;
          pending = Buffer.alloc(0);
          return;
        }
        written += line.length;
        eventsLog.write(line);
        newline = pending.indexOf(0x0a);
      }
      if (pending.length > MAX_LOG - written) {
        cut = true;
        pending = Buffer.alloc(0);
      }
    };
    const finish = () => {
      if (!cut && pending.length && written + pending.length <= MAX_LOG) eventsLog.write(pending);
      pending = Buffer.alloc(0);
    };
    return { append, finish };
  })();

  let child;
  if (onWindows) {
    // Thrown rather than died: in the worker a bare exit would leave the run open, while a
    // throw goes through the crash handler and closes it with meta.json like any failure.
    const bad = unsafeForCmd(args);
    if (bad) throw new Error(`argument unsafe for cmd.exe (contains % or "): ${bad}`);
    const cmdline = ['codex', ...args].map((a) => (/[\s&|<>^]/.test(a) ? `"${a}"` : a)).join(' ');
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmdline}"`], {
      windowsVerbatimArguments: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else {
    child = spawn('codex', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  }

  return new Promise((resolve) => {
    let failed = false;
    let deadlineTimer;
    let heartbeatTimer;
    let stdioGraceTimer;
    let stoppedOnDeadline = false;
    let exitCode;
    let settled = false;
    let elapsedMs = 0;
    const startedAt = Date.now();
    stampHeartbeat();
    heartbeatTimer = setInterval(stampHeartbeat, HEARTBEAT_INTERVAL_MS);
    child.stdout.on('data', appendEvents.append);
    child.stdout.on('end', appendEvents.finish);
    child.stderr.on('data', (chunk) => {
      appendStderr(chunk);
    });
    // A log file that cannot be opened must not leave Codex spending quota unattended. Without
    // a listener the stream's 'error' event throws inside the worker, and the crash handler
    // closes the run folder while the CLI keeps running — the orphan of 2026-07-31 with an
    // extra step. The run dies, but it dies with its child: killing first, recording second.
    const onStreamError = (which) => (err) => {
      failed = true;
      const note = `\nrun-codex: cannot write ${which}: ${err.message}\n`;
      if (which !== 'stderr.log' && stderrLog.writable) stderrLog.write(note);
      stopCodex(child, onWindows);
    };
    stderrLog.on('error', onStreamError('stderr.log'));
    eventsLog.on('error', onStreamError('events.jsonl'));
    child.on('error', (err) => {
      failed = true;
      appendStderr(`\nrun-codex: ${err.message}\n`);
    });
    // Codex that dies before reading the order leaves an EPIPE here; the exit code and the
    // log already say what happened, and an unhandled stream error would replace that with
    // a crash of the runner.
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(taskText, 'utf8'));
    if (deadlineMs !== null) {
      deadlineTimer = setTimeout(() => {
        const elapsed = Date.now() - startedAt;
        // The tree is stopped either way — a grandchild still holding stdio is exactly what
        // the budget exists to end — but only a process that was still alive was killed by
        // the deadline, and only that run may say so.
        if (!exited) {
          stoppedOnDeadline = true;
          elapsedMs = elapsed;
          stderrLog.write(
            `\nrun-codex: run stopped on its deadline after ${elapsed} ms (budget ${deadlineMs} ms)\n`,
          );
        }
        stopCodex(child, onWindows);
      }, deadlineMs);
    }
    // A stream that already failed never calls back from end(), so waiting on both callbacks in
    // sequence hangs the worker until its own deadline — the run then costs a full budget and
    // answers nothing. Closing is best-effort; the verdict is not.
    const close = (stream) =>
      new Promise((done) => {
        if (stream.destroyed || stream.errored) {
          stream.destroy();
          done();
          return;
        }
        stream.end(done);
      });

    // 'exit' fires when Codex is gone; 'close' waits for stdio, which the 2026-08-06 incident
    // showed a grandchild can hold open forever. A bounded drain grace keeps normal logs intact,
    // then closes the run with an explicit marker instead of waiting for an unbounded pipe.
    const finish = async (code, stdioDrained) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (stdioGraceTimer) clearTimeout(stdioGraceTimer);
      if (!stoppedOnDeadline) elapsedMs = Date.now() - startedAt;
      const exit = failed || code === null ? 1 : code;
      appendEvents.finish();
      if (!stdioDrained) {
        try { child.stdout.destroy(); } catch {}
        try { child.stderr.destroy(); } catch {}
      }
      await close(stderrLog);
      await close(eventsLog);
      resolve({ exit, stoppedOnDeadline, elapsedMs, stdioDrained });
    };

    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      // The grace is an argument only so tests can prove the fallback without waiting it out;
      // a run never passes one, because a per-run grace is a second place to configure a
      // contract that must be identical for every run.
      stdioGraceTimer = setTimeout(() => finish(exitCode, false), graceMs);
    });
    child.on('close', (code) => finish(code, true));
  });
}

/**
 * Codex missing or not authorised is a deterministic FAIL, never a reason to improvise.
 * Runs after the folder exists so this failure is recorded like any other.
 */
export function requireCodex(runDir, agent) {
  const probe = spawnSync(
    process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'codex',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'codex --version'] : ['--version'],
    { encoding: 'utf8' },
  );
  if (probe.error || probe.status !== 0) {
    const why = (probe.stderr || probe.error?.message || 'codex --version is not responding').trim();
    const { reply } = writeFailure(runDir, agent, `Codex CLI unavailable: ${why}`, [
      'Operator check: codex --version (and codex login if authorization is rejected)',
    ], true);
    console.log(reply);
    process.exit(1);
  }
}
