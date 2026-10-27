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
import { dispatcherPresence, sessionAgentTypes } from '../lib/agent-listing.mjs';
import { BRAND_HOME, BRAND_STATE_DIR } from '../lib/brand-home.mjs';
import { modelLatch, readDispatcherModel } from '../lib/dispatcher-model.mjs';
import { readDispatcherPin } from '../lib/dispatcher-pin.mjs';
import { recordHookDiagnostic } from '../lib/hook-diagnostics.mjs';
import { transcriptHostVersion } from '../lib/host-version.mjs';
import { readJsonFileSync } from '../lib/json-file.mjs';
import { parseDispatcherCall, renderCallRefusal } from '../lib/dispatcher-call.mjs';
import { orderFromHeader, renderOrderProblems } from '../lib/order-schema.mjs';
import { SUBAGENT_TOOLS } from '../lib/hook-definitions.mjs';
import { taskFingerprint } from '../lib/meta/chain.mjs';
import { withActionRow } from '../lib/runner/args.mjs';
import { conflictingOrderOwner, orderOwnerConflictText } from '../lib/runner/order-owner.mjs';
import { repositoryRefusal, resolveOrderRepository } from '../lib/runner/order-repository.mjs';
import { resolveProjectRunsDir } from '../lib/runner/project-dir.mjs';
import { runsRoot } from '../lib/runner/runs-root.mjs';
import { parseTaskDocument } from '../lib/runner/task-file.mjs';
import { parseTaskHeader, taskHeaderRefusal } from '../lib/task-header.mjs';
import { envModelProblem } from '../lib/subagent-model-env.mjs';
import { orderRuleMessage } from '../lib/order-rules.mjs';
import { orderDiagnosticMessage } from '../lib/order-diagnostics.mjs';
import { checkOutgoingRefusal } from '../lib/order-text-record.mjs';

const GUARDED = new Set(Object.keys(AGENTS));
/**
 * Both spellings of the subagent-launching tool, from the same list the installer builds its
 * matcher from. Recognising only the name this host happens to use would make the gate silent
 * on every other host, and a gate that is silent for an unknown reason is worse than none.
 */
const SUBAGENT_TOOL_NAMES = new Set(SUBAGENT_TOOLS);

let systemMessage;
const pass = () => {
  if (systemMessage) {
    checkOutgoingRefusal(systemMessage, 'system-message');
    process.stdout.write(JSON.stringify({ systemMessage }));
  }
  process.exit(0);
};
const deny = (reason, how) => {
  if (typeof how !== 'object' || how === null || how.action === undefined) {
    throw new Error(orderDiagnosticMessage('next-action-variant-required'));
  }
  reason = withActionRow(reason, how.action);
  checkOutgoingRefusal(reason, 'deny');
  if (systemMessage) checkOutgoingRefusal(systemMessage, 'system-message');
  process.stdout.write(JSON.stringify({
    ...(systemMessage ? { systemMessage } : {}),
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
if (!GUARDED.has(toolInput.subagent_type)) pass();

const agentType = toolInput.subagent_type;
// OW-071, 2026-10-21: refuse before other checks or grants can send an unloaded dispatcher to fallback.
if (typeof input.session_id === 'string' && input.session_id.trim()
  && typeof input.transcript_path === 'string' && input.transcript_path.trim()) {
  let listing;
  let presence;
  try {
    listing = sessionAgentTypes({ transcriptPath: input.transcript_path, sessionId: input.session_id });
    presence = dispatcherPresence(listing, agentType);
  } catch {
    presence = 'unknown';
  }
  if (presence === 'absent') {
    deny(orderDiagnosticMessage('dispatcher-not-loaded', {
      agentType, observedAt: listing.observedAt, records: listing.records,
    }), { action: 'restart-window' });
  }
}

// Plan_67 D6: one installed model contract; refuse even matching aliases before prompt exits.
if (Object.hasOwn(toolInput, 'model')) {
  deny([orderRuleMessage('agent-call-model', { agentType }),
    orderDiagnosticMessage('run-not-created')].join(' '), { action: 'usage' });
}
let problem;
try {
  const hostVersion = await transcriptHostVersion(input.transcript_path).catch(() => null);
  const pin = readDispatcherPin({ brandRoot: BRAND_HOME.root, agentType });
  problem = envModelProblem({ env: process.env, hostVersion, pinFamily: pin.family });
} catch {
  // D6 (b): uncertain host/env evidence is diagnostic only; the stop observer still checks it.
}
if (problem) deny(problem, { action: 'usage' });
try {
  const latch = modelLatch({ ledger: readDispatcherModel({ stateDir: BRAND_STATE_DIR }), agentType });
  if (latch.active) {
    const { data, at } = latch.violation;
    systemMessage = orderDiagnosticMessage('dispatcher-model-latch', {
      agentType, models: data.parsed.join(', '), pinFamily: data.pinFamily, hostVersion: data.hostVersion, at,
    });
  }
} catch {
  // D4 (a): a corrupt ledger must not turn a diagnostic warning into a refusal.
}
if (typeof toolInput.prompt !== 'string') pass();

/**
 * Plan_62 D7: with agent teams enabled, a registered dispatcher launched with `name` or `team_name`
 * starts as a teammate — its `agent_type` becomes the teammate's name and it answers through
 * SendMessage (live probe 2026-09-24, `docs/plans/Plan_62-probe/journal-run1.jsonl`), so the dispatcher
 * gate never recognises it and every prohibition falls back to prompt text. Refused before it starts.
 */
const teammateField = ['name', 'team_name']
  .find((key) => typeof toolInput[key] === 'string' && toolInput[key].trim());
if (teammateField) {
  deny(orderRuleMessage('agent-call-teammate', { field: teammateField, agentType: toolInput.subagent_type }), { action: 'usage' });
}

// Plan_76 D1: exact registry labels prevent the scope-new and repository-prose incident of 2026-10-04.
const call = parseDispatcherCall(toolInput.subagent_type, toolInput.prompt);
if (call.problems.length) deny(renderCallRefusal(toolInput.subagent_type, call.problems), { action: 'usage' });

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
} catch (err) {
  // OW-073, advisor r3: a recognized call must not slip past the repository check.
  deny(orderDiagnosticMessage('task-file-readable', { message: err.message }), { action: 'usage' });
}
// Plan_75 D5, 2026-10-03 20:42: malformed metadata must not disappear into the disk-state guard.
const parsed = parseTaskHeader(rawTask);
const headerRefusal = taskHeaderRefusal(parsed);
if (headerRefusal) deny(headerRefusal, { action: 'usage' });
const { order, problems } = orderFromHeader(toolInput.subagent_type, parsed);
if (problems.length) {
  deny([renderOrderProblems(toolInput.subagent_type, problems), orderDiagnosticMessage('run-not-created')].join('\n'), { action: 'usage' });
}
const orderId = order.get('order id');
const label = order.has('repository') ? order.get('repository') : undefined;
if (order.has('repository')) {
  const reason = repositoryRefusal(label);
  if (reason) deny(reason, { action: 'usage' });
}
// OW-073: a grant cannot authorize a task whose repository disagrees with its label.
const repository = resolveOrderRepository({ taskFile, label });
if (!repository.ok) {
  if (repository.violation === 'repository-label-invalid') {
    deny(repositoryRefusal(repository.values.label), { action: 'usage' });
  }
  const violations = {
    'repository-mismatch': 'mismatch',
    'repository-label-required': 'label-required',
    'repository-discovery-failed': 'discovery-failed',
  };
  deny([orderRuleMessage('repository-source', {
    ...repository.values, violation: violations[repository.violation],
  }), orderDiagnosticMessage('run-not-created')].join('\n'), { action: 'usage' });
}
// Plan_63 D9 / OW-054: only a validated header grant reaches the runner's grant rules.
if (parsed.grant) pass();
let taskHash;
try {
  taskHash = taskFingerprint(parseTaskDocument(parsed.body).task);
} catch {
  // A malformed Questions or Verify section is the runner's refusal to issue, with its own text.
  pass();
}

let owner;
let ownerDir;
try {
  // OW-073: owner history belongs to the resolved task repository, regardless of the hook cwd.
  const projectRunsDir = resolveProjectRunsDir(runsRoot(), repository.repo, { create: false }).dir;
  // Per folder, not per directory: a run folder created a moment before its status.json, or any
  // leftover beside the runs, would otherwise throw out of the whole check and silently disarm the
  // gate for every other order. A guard that one stray folder switches off is not a guard.
  const runs = fs.readdirSync(projectRunsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ run: entry.name, status: readStatus(path.join(projectRunsDir, entry.name, 'status.json')) }))
    .filter(({ status }) => status);
  const conflict = conflictingOrderOwner(runs, orderId, taskHash);
  if (conflict) {
    ownerDir = path.join(projectRunsDir, conflict.run);
    owner = conflict;
  }
} catch {
  // The 2026-08-15 collision guard is diagnostic: uncertain disk state must not block real work.
}
if (owner) deny(orderOwnerConflictText(owner, ownerDir, orderId), { action: 'usage' });

pass();
