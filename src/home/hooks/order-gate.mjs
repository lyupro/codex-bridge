#!/usr/bin/env node
/**
 * PreToolUse gate for the Codex dispatchers (codex-scout / codex-build / codex-review).
 *
 * Plan_63 D9: the call carries only the task file; order id and grant come from its header.
 * OW-054: validate the header and order before a grant can skip the order-owner diagnostic,
 * so a `continue: none` line cannot disarm the check. The producer can still correct the order
 * before the runner creates a run folder or spends quota.
 *
 * Input is Claude Code's hook JSON on stdin. The last payload is retained for diagnostics so a
 * future host schema change can be inspected instead of guessed at. Any uncertain shape passes
 * silently because a diagnostic guard must never break an unrelated tool call.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS } from '../lib/agents.mjs';
import { recordHookDiagnostic } from '../lib/hook-diagnostics.mjs';
import { readJsonFileSync } from '../lib/json-file.mjs';
import { parseDispatcherCall, renderCallRefusal } from '../lib/dispatcher-call.mjs';
import { orderFromHeader, renderOrderProblems } from '../lib/order-schema.mjs';
import { SUBAGENT_TOOLS } from '../lib/hook-definitions.mjs';
import { taskFingerprint } from '../lib/meta/chain.mjs';
import { conflictingOrderOwner, orderOwnerConflictText } from '../lib/runner/order-owner.mjs';
import { resolveProjectRunsDir } from '../lib/runner/project-dir.mjs';
import { runsRoot } from '../lib/runner/runs-root.mjs';
import { parseTaskDocument } from '../lib/runner/task-file.mjs';
import { parseTaskHeader, taskHeaderRefusal } from '../lib/task-header.mjs';

const GUARDED = new Set(Object.keys(AGENTS));
/**
 * Both spellings of the subagent-launching tool, from the same list the installer builds its
 * matcher from. Recognising only the name this host happens to use would make the gate silent
 * on every other host, and a gate that is silent for an unknown reason is worse than none.
 */
const SUBAGENT_TOOL_NAMES = new Set(SUBAGENT_TOOLS);

const pass = () => process.exit(0);
const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
};

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  pass();
}

recordHookDiagnostic('order-gate', input);

if (!input || typeof input !== 'object' || Array.isArray(input)) pass();
if (!SUBAGENT_TOOL_NAMES.has(input.tool_name)) pass();

const toolInput = input.tool_input;
if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) pass();
if (!GUARDED.has(toolInput.subagent_type) || typeof toolInput.prompt !== 'string') pass();

/**
 * Plan_62 D7: with agent teams enabled, a registered dispatcher launched with `name` or `team_name`
 * starts as a teammate — its `agent_type` becomes the teammate's name and it answers through
 * SendMessage (live probe 2026-09-24, `docs/plans/Plan_62-probe/journal-run1.jsonl`), so the dispatcher
 * gate never recognises it and every prohibition falls back to prompt text. Refused before it starts.
 */
const teammateField = ['name', 'team_name']
  .find((key) => typeof toolInput[key] === 'string' && toolInput[key].trim());
if (teammateField) {
  deny(
    `Order gate denied the Agent call because it passes \`${teammateField}\`: a dispatcher launched as a ` +
      'teammate escapes the dispatcher gate, whose agent_type becomes the teammate name. Call ' +
      `${toolInput.subagent_type} with subagent_type only, without name or team_name.`,
  );
}

// Plan_76 D1: exact registry labels prevent the scope-new and repository-prose incident of 2026-10-04.
const call = parseDispatcherCall(toolInput.subagent_type, toolInput.prompt);
if (call.problems.length) deny(renderCallRefusal(toolInput.subagent_type, call.problems));

const readStatus = (file) => {
  try {
    return readJsonFileSync(file);
  } catch {
    return null;
  }
};

const taskFile = call.inputs.get('task file');

let rawTask;
try {
  rawTask = fs.readFileSync(taskFile, 'utf8');
} catch {
  pass();
}
// Plan_75 D5, 2026-10-03 20:42: malformed metadata must not disappear into the disk-state guard.
const parsed = parseTaskHeader(rawTask);
const headerRefusal = taskHeaderRefusal(parsed);
if (headerRefusal) deny(headerRefusal);
const { order, problems } = orderFromHeader(toolInput.subagent_type, parsed);
if (problems.length) {
  deny(`${renderOrderProblems(toolInput.subagent_type, problems)}\nThe run folder was not created; quota was not spent.`);
}
const orderId = order.get('order id');
// Plan_63 D9 / OW-054: only a validated header grant reaches the runner's grant rules.
if (parsed.grant) pass();
let taskHash;
try {
  taskHash = taskFingerprint(parseTaskDocument(parsed.body).task);
} catch {
  // A malformed Questions or Verify section is the runner's refusal to issue, with its own text.
  pass();
}

try {
  const projectRunsDir = resolveProjectRunsDir(runsRoot(), input.cwd, { create: false }).dir;
  // Per folder, not per directory: a run folder created a moment before its status.json, or any
  // leftover beside the runs, would otherwise throw out of the whole check and silently disarm the
  // gate for every other order. A guard that one stray folder switches off is not a guard.
  const runs = fs.readdirSync(projectRunsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ run: entry.name, status: readStatus(path.join(projectRunsDir, entry.name, 'status.json')) }))
    .filter(({ status }) => status);
  const owner = conflictingOrderOwner(runs, orderId, taskHash);
  if (owner) {
    const ownerDir = path.join(projectRunsDir, owner.run);
    deny(orderOwnerConflictText(owner, ownerDir, orderId));
  }
} catch {
  // The 2026-08-15 collision guard is diagnostic: uncertain disk state must not block real work.
}

pass();
