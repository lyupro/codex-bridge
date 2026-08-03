/** Verifies that the config keys the runner passes are real ones that change what Codex offers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const lookup = process.platform === 'win32'
  ? spawnSync('powershell.exe', [
    '-NoProfile', '-Command', '(Get-Command codex -ErrorAction Stop).Source',
  ], { encoding: 'utf8' })
  : { status: 0, stdout: 'codex' };
const codexPath = lookup.stdout?.trim();

function runCodex(args) {
  if (process.platform === 'win32' && path.extname(codexPath).toLowerCase() === '.ps1') {
    return spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', codexPath, ...args,
    ], { encoding: 'utf8' });
  }
  return spawnSync(codexPath || 'codex', args, { encoding: 'utf8' });
}

const probe = lookup.status === 0 ? runCodex(['--version']) : lookup;
const unavailable = probe.error || probe.status !== 0;
const skip = unavailable
  ? `codex binary is unavailable: ${probe.error?.message || probe.stderr?.trim()}`
  : false;

/**
 * A misspelled key is the failure this guards against, and it is silent in the place you would
 * look first: `codex execpolicy check` accepts any -c without loading the config at all. Asking
 * for the model-visible prompt does load it, so a wrong key fails and a right one visibly
 * removes the multi-agent tooling the runner means to withhold.
 */
test('agents.enabled=false is a real key that withholds the multi-agent tools', { skip }, () => {
  const withAgents = runCodex(['debug', 'prompt-input', 'hi']);
  const withoutAgents = runCodex(['debug', 'prompt-input', '-c', 'agents.enabled=false', 'hi']);
  assert.equal(withAgents.status, 0, withAgents.stderr);
  assert.equal(withoutAgents.status, 0, withoutAgents.stderr);
  assert.ok(
    withoutAgents.stdout.length < withAgents.stdout.length,
    'disabling subagents did not change what the model is told it can do',
  );
});

test('an unknown config key is rejected rather than ignored', { skip }, () => {
  const result = runCodex(['debug', 'prompt-input', '-c', 'agents.bogus_key=false', 'hi']);
  assert.notEqual(result.status, 0, 'Codex accepted a key that does not exist');
});
