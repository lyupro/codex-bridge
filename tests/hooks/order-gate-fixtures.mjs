/** Shared fixtures for the order-gate hook tests: a temp project, stored runs, and one gate invocation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GATE = path.join(ROOT, 'src', 'home', 'hooks', 'order-gate.mjs');

export function runGate(root, input) {
  return spawnSync(process.execPath, [GATE], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_RUNS_ROOT: path.join(root, 'runs'),
      HOME: root,
      USERPROFILE: root,
      CODEX_BRIDGE_HOME: path.join(root, '.lyupro', '.codex-bridge'),
    },
  });
}

export async function fixture(t) {
  const root = makeTempTree('bridge-order-gate-');
  t.after(() => removeTempTree(root));
  return root;
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
  const runs = path.join(root, 'runs', 'project');
  const run = path.join(runs, name);
  await fs.mkdir(run, { recursive: true });
  await fs.writeFile(path.join(runs, '.project.json'), `${JSON.stringify({ repo })}\n`);
  await fs.writeFile(path.join(run, 'status.json'), `${JSON.stringify(status)}\n`);
  return run;
}
