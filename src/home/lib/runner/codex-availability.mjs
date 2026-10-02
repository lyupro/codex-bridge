/**
 * Decides from conclusive evidence only whether Codex is missing, signed out, available, or cannot be judged.
 * Plan_60 D2: an inconclusive probe must never become "do not retry".
 */
import { resolveCommandOnPath } from '../command-path.mjs';
import { codexSpawnSpec, spawnCaptured } from './codex-cmd.mjs';

// A signed-in answer takes ~200 ms; ten seconds bounds a hung CLI without delaying a healthy start.
export const PROBE_TIMEOUT_MS = 10_000;

function lines(text) {
  return String(text ?? '').split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
}

function failureDetail(result, command) {
  return lines(result.stderr).at(-1)
    || lines(result.error?.message).at(-1)
    || `${command} exited ${result.status}`;
}

export async function probeCodexAvailability({
  env = process.env, platform = process.platform,
  run = spawnCaptured, resolve = resolveCommandOnPath, timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  try {
    if (resolve('codex', env) === null) {
      return { state: 'missing', detail: 'codex is not on PATH' };
    }
    const capture = (args) => {
      const spec = codexSpawnSpec(args, platform);
      return run(spec.command, spec.args, { ...spec.options, env, timeout: timeoutMs, encoding: 'utf8' });
    };
    const version = await capture(['--version']);
    if (version.error || version.status !== 0) {
      return { state: 'inconclusive', detail: failureDetail(version, 'codex --version') };
    }
    const login = await capture(['login', 'status']);
    // Plan_60 D2: capture errors invalidate even a familiar line; only a completed probe proves sign-out.
    if (login.error) {
      return { state: 'inconclusive', detail: failureDetail(login, 'codex login status') };
    }
    if (login.status === 0) return { state: 'available' };
    if (login.status === 1 && [...lines(login.stderr), ...lines(login.stdout)].includes('Not logged in')) {
      return { state: 'logged-out', detail: 'codex login status: Not logged in' };
    }
    return { state: 'inconclusive', detail: failureDetail(login, 'codex login status') };
  } catch (error) {
    return { state: 'inconclusive', detail: lines(error?.message).at(-1) || 'codex availability probe failed' };
  }
}
