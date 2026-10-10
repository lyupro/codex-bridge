/** Keeps one Codex home resolver for readers and the path currently built inline in cli/hosts.mjs:26. */
import os from 'node:os';
import path from 'node:path';

export function resolveCodexHome({ env = process.env, homedir = os.homedir() } = {}) {
  return typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.length > 0
    ? env.CODEX_HOME : path.join(homedir, '.codex');
}
