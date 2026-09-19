/** Checks whether this host's Codex sandbox can start a process before a run spends quota. */
import { performance } from 'node:perf_hooks';
import { sandboxModeFor } from './codex-args.mjs';
import { codexSpawnSpec, spawnCaptured } from './codex-cmd.mjs';
import { platformSandboxArgs } from './sandbox-flags.mjs';

export const SANDBOX_PROBE_MARKER = 'codex-bridge-sandbox-ok';
// Plan_57 D12/D19: a platform is judged only after both outcomes were seen live. Linux joined on
// 2026-09-17: dead on an Ubuntu 24.04 VPS (bwrap without a user namespace, exit 1, no marker), alive
// on the same host after the AppArmor repair. macOS has never been observed.
export const PROBED_PLATFORMS = new Set(['win32', 'linux']);

// Ubuntu 23.10+ forbids unprivileged user namespaces unless an AppArmor profile allows bwrap; that
// is the ordinary state of a fresh server, not an accident like the corrupted Windows state file.
const LINUX_REPAIR = [
  'On Ubuntu 23.10 and later this usually means AppArmor does not let bubblewrap create a user namespace.',
  'Official repair: https://learn.chatgpt.com/docs/sandboxing — the bwrap-userns-restrict AppArmor profile',
  '(Ubuntu 24.04) or the bubblewrap package (25.04 and later). Do not set',
  'kernel.apparmor_restrict_unprivileged_userns=0: it lifts the restriction for every program on the host.',
].join(' ');

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

export async function probeSandbox({
  agent, repo, platform = process.platform, run = spawnCaptured, timeoutMs = 30_000,
}) {
  if (!PROBED_PLATFORMS.has(platform)) return { outcome: 'skipped' };
  const sandbox = sandboxModeFor(agent);
  if (typeof repo !== 'string' || !repo) throw new Error('sandbox probe requires a repository path');
  const echo = echoArgs(platform);
  const attempts = [];
  const finish = (outcome, reason) => ({ outcome, reason, attempts });
  const attempt = async (form, args) => {
    const spec = codexSpawnSpec(args, platform);
    const started = performance.now();
    const result = await run(spec.command, spec.args, {
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
  const flagged = await attempt('flagged', [
    'sandbox', ...platformSandboxArgs(platform), '-c', `sandbox_mode=${sandbox}`, '--', ...echo,
  ]);
  const flaggedReason = inconclusiveReason(flagged, 'flagged');
  if (flaggedReason) return finish('inconclusive', flaggedReason);
  if (flagged.status === 0 && flagged.marker) {
    return finish('alive', 'The Codex sandbox started a process.');
  }
  // D16: the marker proves a process started, so a nonzero exit cannot prove a dead sandbox.
  if (flagged.marker) {
    return finish('inconclusive', `The flagged sandbox probe printed the marker but exited ${flagged.status}.`);
  }

  const control = await attempt('control', ['sandbox', '--', ...echo]);
  const controlReason = inconclusiveReason(control, 'control');
  if (controlReason) return finish('inconclusive', controlReason);
  if (control.marker) {
    return finish('inconclusive', 'This version of Codex no longer accepts the package sandbox flags.');
  }

  const version = await attempt('version', ['--version']);
  if (version.error || version.signal || version.status !== 0) {
    // codexUnavailableReason() owns the refusal for an unavailable CLI, in the same pre-flight pass.
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
  // Only a dead result is refused, and its reason already is the headline; printing both said it twice.
  return [
    result.reason,
    'Repair the host sandbox; do not rewrite or retry the order.',
    ...(platform === 'linux' ? [LINUX_REPAIR] : []),
    `Operator check (run from the repository directory): ${control}`,
    ...stderr,
    'The run folder was not created; quota was not spent.',
  ].join('\n\n');
}
