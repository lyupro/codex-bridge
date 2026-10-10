/** Runs a hardened host session and waits for asynchronous evidence because Plan_64 D13 requires isolated project-only proof. */
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { spawnCaptured } from '../../src/home/lib/runner/codex-cmd.mjs';
import { readLoadWitness } from '../../src/home/lib/load-witness.mjs';

export async function runSession({ target, tree, env, model, sessionId, spawn = spawnCaptured }) {
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('A model is required.');
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('A session ID is required.');
  try {
    const result = await spawn(target.executable, [
      '--setting-sources', 'project', '--strict-mcp-config', '--tools', '',
      '--model', model, '--session-id', sessionId, '-p', 'Reply with the single word OK.',
    ], { cwd: tree.project, env, timeout: 120_000, shell: false, windowsHide: true });
    if (!result || result.error || result.signal || result.status !== 0) {
      const cause = result?.error?.message ?? (result?.signal ? `signal ${result.signal}` : `exit ${result?.status}`);
      return { ok: false, reason: `Host session failed: ${cause}\n${String(result?.stderr ?? '').slice(-4000)}`.trim() };
    }
    return { ok: true, reason: 'Host session exited successfully.' };
  } catch (error) {
    return { ok: false, reason: `Host session failed: ${error.message}\n${String(error.stderr ?? '').slice(-4000)}`.trim() };
  }
}

const comparable = (value) => {
  const normalized = String(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

// Each InstructionsLoaded event is its own hook process, so the operator's user core can be recorded before the
// project core; with an expectedPath the wait ends only on that exact path, never on the first load of the session.
export async function awaitWitness({ stateDir, sessionId, expectedPath, deadlineMs = 15_000, pollMs = 250,
  read = readLoadWitness, now = () => performance.now(), sleep = delay }) {
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new TypeError('Witness deadline must be nonnegative and poll interval must be positive.');
  }
  const deadline = now() + deadlineMs;
  const wanted = expectedPath ? comparable(expectedPath) : null;
  for (;;) {
    const witness = await read({ stateDir });
    const session = witness?.sessions && Object.hasOwn(witness.sessions, sessionId) ? witness.sessions[sessionId] : null;
    const loads = Array.isArray(session?.loads) ? session.loads : [];
    if (wanted ? loads.some((load) => typeof load?.path === 'string' && comparable(load.path) === wanted) : loads.length > 0) {
      return witness;
    }
    const remaining = deadline - now();
    if (remaining <= 0) return witness;
    await sleep(Math.min(pollMs, remaining));
  }
}
