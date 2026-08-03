/**
 * Everything about invoking the `codex` CLI: which flags a run gets, whether the CLI is
 * there at all, and how its output reaches raw.log.
 *
 * The flag sets below are the ones the three agent files carried before, verbatim.
 * Sandboxes especially must not drift: codex-scout is read-only through
 * --ignore-user-config, codex-build needs workspace-write and must NOT get
 * --ignore-user-config, codex-review needs an explicit --sandbox read-only before the
 * `review` subcommand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { writeFailure } from '../write-meta.mjs';
import { MAX_LOG } from './git-state.mjs';
import { CLEAN_ENV, RUN_ENV } from './run-env.mjs';

/**
 * An argument cmd.exe cannot be handed safely, or undefined. `%` is fatal because cmd
 * expands variables even inside quotes. The launcher asks first, so the refusal costs
 * nothing; the worker asks again on its own copy, because a process whose stderr goes
 * nowhere must not be the one to discover this.
 */
export const unsafeForCmd = (args) =>
  ['codex', ...args].find((a) => a.includes('%') || a.includes('"'));

/**
 * Windows npm ships `codex` as codex.cmd, and Node refuses to spawn .cmd without a
 * shell. One command line through cmd.exe keeps a single code path; every argument is
 * quoted here, and unsafeForCmd() has already refused the ones that cannot be.
 *
 * The log is streamed, not collected: spawnSync kept every byte in memory and wrote the file
 * only on return, so a worker killed at minute twelve left raw.log missing entirely and the
 * run became unexplainable (2026-07-31, run 114736). Now whatever Codex has already said is
 * on disk, and the task text is pushed into stdin by hand since there is no `input` option
 * outside spawnSync. MAX_LOG stays the ceiling; past it the log is cut with a note rather
 * than the run being killed — a huge log is a diagnosis, not a reason to lose the work.
 */
export function runCodex(args, taskText, logPath) {
  const onWindows = process.platform === 'win32';
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  let written = 0;
  let cut = false;
  const append = (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    if (written >= MAX_LOG) {
      if (!cut) {
        cut = true;
        log.write(`\nrun-codex: log truncated at ${MAX_LOG} bytes; further output is not saved\n`);
      }
      return;
    }
    const room = MAX_LOG - written;
    const slice = buf.length > room ? buf.subarray(0, room) : buf;
    written += slice.length;
    log.write(slice);
  };

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
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (err) => {
      failed = true;
      append(`\nrun-codex: ${err.message}\n`);
    });
    // Codex that dies before reading the order leaves an EPIPE here; the exit code and the
    // log already say what happened, and an unhandled stream error would replace that with
    // a crash of the runner.
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(taskText, 'utf8'));
    child.on('close', (code) => {
      log.end(() => resolve(failed || code === null ? 1 : code));
    });
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
    ]);
    console.log(reply);
    process.exit(1);
  }
}

/**
 * Which model runs a mode, and how deep it reasons.
 *
 * Three sources, in this order: what the dispatcher asked for this one task, the mode's
 * configured profile, and finally a depth to fall back on. The order is the whole point —
 * pinning a model without its depth leaves every run at the fallback, which is how a mode
 * configured for maximum reasoning would quietly keep working at the shallowest setting.
 */
const FALLBACK_EFFORT = 'medium';

function runProfile(opts) {
  const mode = {
    'codex-scout': 'scout',
    'codex-build': 'build',
    'codex-review': 'review',
  }[opts.agent];
  // opts.models is how tests state a configuration; a real run reads the one loaded for it.
  const configured = (opts.models || RUN_ENV?.models || {})[mode] || {};
  return {
    model: configured.model || '',
    effort: opts.effort || configured.effort || FALLBACK_EFFORT,
  };
}

export function codexArgs(opts, runDir, isGitRepo) {
  const schema = path.join(runDir, 'schema.json');
  const profile = runProfile(opts);
  const effort = `model_reasoning_effort=${profile.effort}`;
  const modelArgs = profile.model ? ['-m', profile.model] : [];
  if (opts.agent === 'codex-scout') {
    return [
      'exec',
      ...CLEAN_ENV,
      '--ignore-user-config',
      '-c',
      effort,
      ...modelArgs,
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '-C',
      opts.repo,
      '--output-schema',
      schema,
      '-o',
      path.join(runDir, 'result.json'),
      '-',
    ];
  }
  if (opts.agent === 'codex-build') {
    // --ignore-user-config is deliberately absent: with it Codex forces read-only and
    // every edit is rejected ("writing is blocked by read-only sandbox").
    return [
      'exec',
      ...CLEAN_ENV,
      '-c',
      effort,
      ...modelArgs,
      '--sandbox',
      'workspace-write',
      '-C',
      opts.repo,
      ...(isGitRepo ? [] : ['--skip-git-repo-check']),
      '--output-schema',
      schema,
      '-o',
      path.join(runDir, 'result.json'),
      '-',
    ];
  }
  // codex-review deliberately does NOT use the `review` subcommand. Two of its traits
  // break the contract this design rests on: it rejects a scope flag together with a
  // prompt ("the argument '--uncommitted' cannot be used with '[PROMPT]'"), so task.md
  // was silently discarded and the review rules never arrived; and it ignores
  // --output-schema, writing prose into -o, so the old JSON parsing of review.json could
  // only ever fail — which is what pushed a dispatcher into reviewing the diff itself.
  //
  // Plain `codex exec` honours the schema (proven by codex-scout), so the review comes
  // back as machine-checkable JSON. Scope lives in the prompt as a file list plus the
  // exact diff command computed by reviewScope(). Read-only through
  // --ignore-user-config, same as scout: review never needs write access.
  return [
    'exec',
    ...CLEAN_ENV,
    '--ignore-user-config',
    '-c',
    effort,
    ...modelArgs,
    '--sandbox',
    'read-only',
    '-C',
    opts.repo,
    '--output-schema',
    schema,
    '-o',
    path.join(runDir, 'review.json'),
    '-',
  ];
}
