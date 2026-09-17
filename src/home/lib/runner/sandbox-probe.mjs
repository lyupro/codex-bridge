/** Checks whether this host's Codex sandbox can start a process before a run spends quota. */
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { sandboxModeFor } from './codex-args.mjs';
import { codexSpawnSpec } from './codex-cmd.mjs';
import { platformSandboxArgs } from './sandbox-flags.mjs';

export const SANDBOX_PROBE_MARKER = 'codex-bridge-sandbox-ok';
// Plan_57 D12: the command is ready for Linux, but enabling judgment there is an operator decision.
export const PROBED_PLATFORMS = new Set(['win32']);

const echoArgs = (platform) => platform === 'win32'
  ? ['cmd', '/d', '/c', 'echo', SANDBOX_PROBE_MARKER]
  : ['echo', SANDBOX_PROBE_MARKER];

function inconclusiveReason(result, form) {
  if (result.error) {
    return result.error.code === 'ETIMEDOUT'
      ? `The ${form} sandbox probe timed out.`
      : `The ${form} sandbox probe could not start or complete.`;
  }
  if (result.signal) return `The ${form} sandbox probe was terminated by ${result.signal}.`;
  if (result.status === 2) return `Codex rejected the ${form} sandbox probe arguments.`;
  if (result.status == null) return `The ${form} sandbox probe returned no exit status.`;
  return null;
}

export function probeSandbox({
  agent, repo, platform = process.platform, run = spawnSync, timeoutMs = 30_000,
}) {
  if (!PROBED_PLATFORMS.has(platform)) return { outcome: 'skipped' };
  const sandbox = sandboxModeFor(agent);
  if (typeof repo !== 'string' || !repo) throw new Error('sandbox probe requires a repository path');
  const echo = echoArgs(platform);
  const attempts = [];
  const finish = (outcome, reason) => ({ outcome, reason, attempts });
  const attempt = (form, args) => {
    const spec = codexSpawnSpec(args, platform);
    const started = performance.now();
    const result = run(spec.command, spec.args, {
      ...spec.options, cwd: repo, encoding: 'utf8', timeout: timeoutMs,
    });
    const marker = String(result.stdout ?? '').includes(SANDBOX_PROBE_MARKER);
    attempts.push({
      form, status: result.status ?? null, marker,
      ms: Math.round(performance.now() - started),
      // D2: stderr is evidence for the operator, never input to the verdict.
      stderrTail: String(result.stderr ?? '').slice(-300),
    });
    return { ...result, marker };
  };

  // On 2026-09-16 a corrupt deny_read_acl_state.json made every paid run unable to start tools.
  // On 2026-09-17, -C required --permission-profile instead: cwd must be a process option.
  // D16: no single failure exit code proves a dead sandbox; both forms and a live CLI must agree.
  const flagged = attempt('flagged', [
    'sandbox', ...platformSandboxArgs(platform), '-c', `sandbox_mode=${sandbox}`, '--', ...echo,
  ]);
  const flaggedReason = inconclusiveReason(flagged, 'flagged');
  if (flaggedReason) return finish('inconclusive', flaggedReason);
  if (flagged.status === 0 && flagged.marker) {
    return finish('alive', 'The Codex sandbox started a process.');
  }

  const control = attempt('control', ['sandbox', '--', ...echo]);
  const controlReason = inconclusiveReason(control, 'control');
  if (controlReason) return finish('inconclusive', controlReason);
  if (control.marker) {
    return finish('inconclusive', 'This version of Codex no longer accepts the package sandbox flags.');
  }

  const version = attempt('version', ['--version']);
  if (version.error || version.signal || version.status !== 0) {
    // requireCodex() owns the later, recorded failure for an unavailable CLI.
    return finish('inconclusive', 'Codex CLI is unavailable.');
  }
  return finish('dead', 'The Codex sandbox on this host cannot start a process.');
}

export function sandboxRefusal(result, platform = process.platform) {
  const control = ['codex', 'sandbox', '--', ...echoArgs(platform)].join(' ');
  const stderr = result.attempts
    .filter(({ form }) => form === 'flagged' || form === 'control')
    .map(({ form, stderrTail }) =>
      `${form} stderr:\n> ${(stderrTail || '(empty)').replace(/\r\n?/g, '\n').replace(/\n/g, '\n> ')}`);
  return [
    'The Codex sandbox on this host cannot start a process.',
    `Reason: ${result.reason}`,
    'Repair the host sandbox; do not rewrite or retry the order.',
    `Operator check (run from the repository directory): ${control}`,
    ...stderr,
    'The run folder was not created; quota was not spent.',
  ].join('\n\n');
}
