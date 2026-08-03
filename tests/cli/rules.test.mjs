/** Verifies the shipped Codex execpolicy against destructive and routine Git commands. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const RULES = path.resolve('src', 'rules', 'codex-bridge.rules');
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

// Every case states the exact decision, including "allow": asserting merely "not forbidden" would
// pass a policy that silently moved routine inspection under confirmation, and a run that has to
// ask before `git status` is as broken as one that may rewrite history.
const cases = [
  { command: ['git', 'reset', '--hard', 'HEAD~1'], decision: 'forbidden' },
  { command: ['git', 'reset', 'HEAD', '--', 'file.txt'], decision: 'forbidden' },
  { command: ['git', 'checkout', 'master'], decision: 'forbidden' },
  { command: ['git', 'branch', '-D', 'feature'], decision: 'forbidden' },
  { command: ['git', 'stash', 'drop'], decision: 'forbidden' },
  { command: ['git', 'push', 'origin', 'master'], decision: 'forbidden' },
  { command: ['git', 'merge', 'feature'], decision: 'forbidden' },
  { command: ['rm', '-rf', 'build'], decision: 'forbidden' },
  // Restoring is confirmed rather than forbidden, and it is confirmed in every form: a run rewinds
  // neither the tree nor the index, so no spelling of it is the safe way out of the bans above.
  { command: ['git', 'restore', 'file.txt'], decision: 'prompt' },
  { command: ['git', 'restore', '--staged', 'file.txt'], decision: 'prompt' },
  { command: ['git', 'status'], decision: 'allow' },
  { command: ['git', 'diff', '--stat'], decision: 'allow' },
  { command: ['git', 'show', 'HEAD:file.txt'], decision: 'allow' },
  { command: ['git', 'add', 'file.txt'], decision: 'allow' },
  { command: ['git', 'commit', '-m', 'msg'], decision: 'allow' },
  { command: ['git', 'branch', '--show-current'], decision: 'allow' },
  { command: ['git', 'stash'], decision: 'allow' },
  { command: ['git', 'stash', 'list'], decision: 'allow' },
  { command: ['rm', '-f', 'stale.txt'], decision: 'allow' },
];

test('codex execpolicy decisions protect repository history without blocking routine inspection', {
  skip: unavailable ? `codex binary is unavailable: ${probe.error?.message || probe.stderr.trim()}` : false,
}, () => {
  for (const entry of cases) {
    const result = runCodex([
      'execpolicy', 'check', '--pretty', '--rules', RULES, '--', ...entry.command,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${entry.command.join(' ')}: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    // No matching rule is reported as an empty match list rather than a decision, and that is
    // exactly the "allow" case: Codex runs an unmatched command without asking.
    assert.equal(parsed.decision ?? 'allow', entry.decision, entry.command.join(' '));
  }
});
