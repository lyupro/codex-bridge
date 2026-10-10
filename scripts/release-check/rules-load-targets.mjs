/** Resolves and preflights separate release-check hosts because Plan_64 D12/D13 and the 2026-10-10 manual run require both installation roles. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveCommandOnPath } from '../../src/home/lib/command-path.mjs';
import { parseHostVersion } from '../../cli/host-contract.mjs';

export const REQUIRED_FLAGS = Object.freeze(['--setting-sources', '--strict-mcp-config', '--tools']);
const PREFLIGHT_TIMEOUT_MS = 5000;

export function resolveTargets({ env, vscodeExecutable, resolveOnPath = resolveCommandOnPath, exists = existsSync }) {
  let cli;
  try {
    const executable = resolveOnPath('claude', env);
    cli = typeof executable === 'string' && path.isAbsolute(executable) && exists(executable)
      ? { role: 'cli', executable, source: 'path' }
      : { role: 'cli', error: 'Claude CLI was not found as an absolute file on PATH.' };
  } catch (error) {
    cli = { role: 'cli', error: `Cannot resolve Claude CLI on PATH: ${error.message}` };
  }

  let vscode;
  try {
    const fromFlag = vscodeExecutable !== undefined;
    const candidate = fromFlag ? vscodeExecutable : env.CLAUDE_CODE_EXECPATH;
    const extensionPath = typeof candidate === 'string'
      && candidate.replaceAll('\\', '/').toLowerCase().includes('/extensions/anthropic.claude-code-');
    if (typeof candidate !== 'string' || !candidate.trim() || (!fromFlag && !extensionPath)) {
      vscode = { role: 'vscode', error: 'Provide --vscode-executable: no extension-session executable is available.' };
    } else {
      const executable = path.resolve(candidate);
      vscode = exists(executable)
        ? { role: 'vscode', executable, source: fromFlag ? 'flag' : 'extension-session' }
        : { role: 'vscode', error: `The --vscode-executable target does not exist: ${executable}` };
    }
  } catch (error) {
    vscode = { role: 'vscode', error: `Cannot resolve --vscode-executable: ${error.message}` };
  }
  return { cli, vscode };
}

export function preflightTarget({ target, run }) {
  try {
    if (target?.error) return { ok: false, reason: target.error };
    if (!target?.executable) return { ok: false, reason: 'Target executable is missing.' };
    const options = {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: PREFLIGHT_TIMEOUT_MS,
    };
    const versionResult = run(target.executable, ['--version'], options);
    if (!versionResult || versionResult.error || versionResult.status !== 0) {
      return { ok: false, reason: `Cannot run --version: ${versionResult?.error?.message ?? 'unsuccessful process exit'}` };
    }
    const version = parseHostVersion(versionResult.stdout);
    if (!version) return { ok: false, reason: 'Host version is unreadable.' };

    const helpResult = run(target.executable, ['--help'], options);
    if (!helpResult || helpResult.error || helpResult.status !== 0) {
      return { ok: false, reason: `Cannot run --help: ${helpResult?.error?.message ?? 'unsuccessful process exit'}` };
    }
    const help = typeof helpResult.stdout === 'string' ? helpResult.stdout : '';
    const missing = REQUIRED_FLAGS.filter((flag) => !new RegExp(`(^|[\\s,])${flag}(?=$|[\\s=,])`).test(help));
    if (missing.length) return { ok: false, reason: `Host help is missing required flags: ${missing.join(', ')}` };
    return { ok: true, version };
  } catch (error) {
    return { ok: false, reason: `Host preflight could not run: ${error.message}` };
  }
}
