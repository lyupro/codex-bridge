/** Proves the PATH launcher dispatches guards from the home being installed. */
import path from 'node:path';
import { HOOK_LAUNCHER_PROTOCOL } from './hook.mjs';
import { runReachableCommand } from './settings-merge.mjs';
import { parseJsonText } from '../src/home/lib/json-file.mjs';

function normalizeRoot(root) {
  let normalized = root.replaceAll('\\', '/').replace(/\/+$/, '');
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

export function probeHookLauncher({ env, brandRoot }) {
  const result = runReachableCommand('codex-bridge', ['hook', '--home'], env);
  if (!result) return { ok: false, reason: 'codex-bridge is not on PATH' };
  if (result.status !== 0) {
    return { ok: false, reason: 'codex-bridge on PATH is not a launcher (hook --home failed)' };
  }
  let answer;
  try {
    answer = parseJsonText('codex-bridge hook --home', result.stdout);
  } catch {
    return { ok: false, reason: 'malformed launcher answer' };
  }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    return { ok: false, reason: 'malformed launcher answer' };
  }
  if (answer.protocol !== HOOK_LAUNCHER_PROTOCOL) {
    return { ok: false, reason: `unsupported launcher protocol ${String(answer.protocol)}` };
  }
  if (answer.dispatch !== 'home' || typeof answer.homeRoot !== 'string' || !answer.homeRoot.trim()) {
    return { ok: false, reason: 'malformed launcher answer' };
  }
  if (normalizeRoot(answer.homeRoot) !== normalizeRoot(path.resolve(brandRoot))) {
    return { ok: false, reason: `launcher runs from ${answer.homeRoot}, not ${brandRoot}` };
  }
  return { ok: true, commandPath: result.path, homeRoot: answer.homeRoot };
}
