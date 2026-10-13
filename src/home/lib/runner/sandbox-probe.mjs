/** Checks whether this host's Codex sandbox can start a process before a run spends quota. */
import { performance } from 'node:perf_hooks';
import { orderDiagnosticMessage } from '../order-diagnostics.mjs';
import { sandboxModeFor } from './codex-args.mjs';
import { codexSpawnSpec, spawnCaptured } from './codex-cmd.mjs';
import { platformSandboxArgs } from './sandbox-flags.mjs';
import { resolveCodexHome } from '../codex-home.mjs';
import { snapshotSandboxLogs, diagnoseSandbox, formatSandboxDiagnosis } from './sandbox-diagnosis.mjs';

export const SANDBOX_PROBE_MARKER = 'codex-bridge-sandbox-ok';
// Plan_57 D12/D19: a platform is judged only after both outcomes were seen live. Linux joined on
// 2026-09-17: dead on an Ubuntu 24.04 VPS (bwrap without a user namespace, exit 1, no marker), alive
// on the same host after the AppArmor repair. macOS has never been observed.
export const PROBED_PLATFORMS = new Set(['win32', 'linux']);

const echoArgs = (platform) => platform === 'win32'
  ? ['cmd', '/d', '/c', 'echo', SANDBOX_PROBE_MARKER]
  : ['echo', SANDBOX_PROBE_MARKER];

function inconclusiveReason(result, form) {
  if (result.error) {
    return result.error.code === 'ETIMEDOUT'
      ? orderDiagnosticMessage('sandbox-probe-reason', { variant: 'timeout', form })
      : orderDiagnosticMessage('sandbox-probe-reason', { variant: 'incomplete', form });
  }
  if (result.signal) return orderDiagnosticMessage('sandbox-probe-reason', { variant: 'signal', form, signal: result.signal });
  if (result.status === 2) return orderDiagnosticMessage('sandbox-probe-reason', { variant: 'arguments', form });
  if (result.status == null) return orderDiagnosticMessage('sandbox-probe-reason', { variant: 'no-status', form });
  return null;
}

export async function probeSandbox({
  agent, repo, platform = process.platform, run = spawnCaptured, timeoutMs = 30_000,
  codexHome = resolveCodexHome(), clock = () => new Date(),
}) {
  if (!PROBED_PLATFORMS.has(platform)) return { outcome: 'skipped' };
  const sandbox = sandboxModeFor(agent);
  if (typeof repo !== 'string' || !repo) throw new Error(orderDiagnosticMessage('sandbox-probe-repository-required'));
  const echo = echoArgs(platform);
  const attempts = [];
  // The 2026-10-10 TradeForge refusals showed only "setup refresh had errors"; capture the
  // baseline before any attempt so old log errors cannot prescribe a repair for this probe.
  let before = null;
  try {
    before = snapshotSandboxLogs({ codexHome, now: clock() });
  } catch {
    // Same rule as the diagnosis below: a log that cannot be read never stops the probe.
  }
  const finish = (outcome, reason) => {
    const result = { outcome, reason, attempts };
    if (outcome === 'dead') {
      if (before === null) {
        result.diagnosis = null;
        return result;
      }
      // D2: logs, like stderr, are operator evidence, never input to the verdict.
      try {
        result.diagnosis = diagnoseSandbox({ codexHome, before, now: clock() });
      } catch {
        result.diagnosis = null;
      }
    }
    return result;
  };
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
    return finish('alive', orderDiagnosticMessage('sandbox-probe-reason', { variant: 'alive' }));
  }
  // D16: the marker proves a process started, so a nonzero exit cannot prove a dead sandbox.
  if (flagged.marker) {
    return finish('inconclusive', orderDiagnosticMessage('sandbox-probe-reason', { variant: 'marker-exit', status: flagged.status }));
  }

  const control = await attempt('control', ['sandbox', '--', ...echo]);
  const controlReason = inconclusiveReason(control, 'control');
  if (controlReason) return finish('inconclusive', controlReason);
  if (control.marker) {
    return finish('inconclusive', orderDiagnosticMessage('sandbox-probe-reason', { variant: 'flags' }));
  }

  const version = await attempt('version', ['--version']);
  if (version.error || version.signal || version.status !== 0) {
    // codexAvailabilityRefusal() owns the refusal for an unavailable CLI, earlier in the same pre-flight pass.
    return finish('inconclusive', orderDiagnosticMessage('sandbox-probe-reason', { variant: 'unavailable' }));
  }
  return finish('dead', orderDiagnosticMessage('sandbox-probe-reason', { variant: 'dead' }));
}

export function sandboxRefusal(result, platform = process.platform) {
  const controlCommand = ['codex', 'sandbox', '--', ...echoArgs(platform)].join(' ');
  const stderr = result.attempts
    .filter(({ form }) => form === 'flagged' || form === 'control')
    .map(({ form, stderrTail }) => orderDiagnosticMessage('sandbox-stderr-evidence', { form, stderrTail }));
  // Only a dead result is refused, and its reason already is the headline; printing both said it twice.
  return [
    result.reason,
    orderDiagnosticMessage('sandbox-refusal-repair'),
    ...(platform === 'linux' ? [orderDiagnosticMessage('sandbox-linux-repair')] : []),
    orderDiagnosticMessage('sandbox-operator-check', { command: controlCommand }),
    ...stderr,
    ...(result.diagnosis && typeof result.diagnosis === 'object'
      ? [formatSandboxDiagnosis(result.diagnosis).join('\n')] : []),
    orderDiagnosticMessage('run-not-created'),
  ].join('\n\n');
}
