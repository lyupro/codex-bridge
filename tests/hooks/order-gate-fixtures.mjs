/** Shared fixtures for the order-gate hook tests: a temp project, stored runs, and one gate invocation. */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GATE = path.join(ROOT, 'src', 'home', 'hooks', 'order-gate.mjs');

export function decodeDenial(stdout) {
  const decision = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  const row = orderDiagnosticMessage('next-action', { variant: 'usage' });
  const lines = decision.permissionDecisionReason.split('\n');
  assert.equal(lines.at(-1), row);
  const label = row.slice(0, row.indexOf(':') + 1);
  assert.equal(lines.slice(0, -1).some((line) => line.startsWith(label)), false);
  return decision;
}

export function runGate(root, input, env = {}) {
  return spawnSync(process.execPath, [GATE], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CODE_SUBAGENT_MODEL: '',
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '',
      CODEX_RUNS_ROOT: path.join(root, 'runs'),
      HOME: root,
      USERPROFILE: root,
      CODEX_BRIDGE_HOME: path.join(root, '.lyupro', '.codex-bridge'),
      ...env,
    },
  });
}

export async function fixture(t) {
  const root = makeTempTree('bridge-order-gate-');
  t.after(() => removeTempTree(root));
  return root;
}

export async function gitRepositories(root) {
  const repos = ['A', 'B'].map((name) => path.join(root, name));
  for (const repo of repos) {
    await fs.mkdir(repo);
    const init = spawnSync('git', ['init', repo], { encoding: 'utf8', windowsHide: true });
    if (init.error) throw init.error;
    if (init.status !== 0) throw new Error(init.stderr);
  }
  return Promise.all(repos.map((repo) => fs.realpath(repo)));
}

export function payload(subagentType, prompt, toolName = 'Agent', cwd = undefined) {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { subagent_type: subagentType, prompt },
    tool_use_id: 'toolu-test-order-gate',
    cwd,
  });
}

export function validPrompt(taskFile) {
  return `task file: ${taskFile}`;
}

export async function writeTaskFile(root, header, body) {
  const taskFile = path.join(root, 'task.md');
  await fs.writeFile(taskFile, `${header}\n\n${body}`);
  return taskFile;
}

export async function createStoredRun(root, repo, name, status) {
  await fs.mkdir(repo, { recursive: true });
  const runs = path.join(root, 'runs', path.basename(repo));
  const run = path.join(runs, name);
  await fs.mkdir(run, { recursive: true });
  await fs.writeFile(path.join(runs, '.project.json'), `${JSON.stringify({ repo })}\n`);
  await fs.writeFile(path.join(run, 'status.json'), `${JSON.stringify(status)}\n`);
  return run;
}
