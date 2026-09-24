#!/usr/bin/env node
/** Enforces each dispatcher order at the host tool boundary and returns only the runner's verdict. */
import fs from 'node:fs';
import { AGENTS } from '../lib/agents.mjs';
import { BRAND_STATE_DIR } from '../lib/brand-home.mjs';
import { sameCommand } from '../lib/dispatcher-command.mjs';
import { parseJsonText } from '../lib/json-file.mjs';
import {
  decidePreToolUse,
  gateOrder,
  HANDBACK_TOOL,
  isFinalOutput,
  runnerOutput,
} from '../lib/dispatcher-gate.mjs';
import {
  pruneDispatcherStates,
  readDispatcherState,
  updateDispatcherState,
} from '../lib/dispatcher-state.mjs';
import { hostSdkVersion, recordHandbackWitness } from '../lib/handback-witness.mjs';

function emit(decision, toolInput) {
  const hookSpecificOutput = {
    hookEventName: 'PreToolUse',
    permissionDecision: decision.kind,
  };
  if (decision.kind === 'deny') hookSpecificOutput.permissionDecisionReason = decision.reason;
  if (decision.kind === 'allow') {
    hookSpecificOutput.updatedInput = { ...toolInput, message: decision.message };
  }
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput })}\n`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  let payload;
  try {
    payload = parseJsonText('stdin', fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }

  if (!payload || !Object.prototype.hasOwnProperty.call(AGENTS, payload.agent_type)
    || typeof payload.session_id !== 'string' || payload.session_id.length === 0
    || typeof payload.agent_id !== 'string' || payload.agent_id.length === 0) return;

  const ids = {
    stateDir: BRAND_STATE_DIR,
    sessionId: payload.session_id,
    agentId: payload.agent_id,
  };

  if (payload.hook_event_name === 'PreToolUse') {
    let decision;
    let order;
    try {
      order = gateOrder(payload);
      const stored = readDispatcherState(ids);
      const state = stored?.corrupt ? {} : (stored || {});
      decision = decidePreToolUse({ payload, order, state });
      if (decision.stateUpdate) {
        await updateDispatcherState(ids, (current) => ({
          ...(current.corrupt ? {} : current),
          ...decision.stateUpdate,
        }));
      }
    } catch (error) {
      decision = {
        kind: 'deny',
        reason: `codex-bridge dispatcher gate: internal error: ${errorMessage(error)}`,
      };
    }

    if (payload.tool_name === HANDBACK_TOOL) {
      try {
        await recordHandbackWitness({
          stateDir: BRAND_STATE_DIR,
          kind: 'seen',
          sdkVersion: hostSdkVersion(),
        });
      } catch {}
      try {
        pruneDispatcherStates({ stateDir: BRAND_STATE_DIR });
      } catch {}
    }

    if (decision.kind !== 'pass') emit(decision, payload.tool_input || {});
    return;
  }

  if ((payload.hook_event_name === 'PostToolUse' || payload.hook_event_name === 'PostToolUseFailure')
    && payload.tool_name === 'Bash') {
    try {
      const order = gateOrder(payload);
      if (!order.command || !sameCommand(payload.tool_input?.command, order.command)) return;
      const result = runnerOutput(payload);
      if (!result) return;
      await updateDispatcherState(ids, (current) => ({
        ...(current.corrupt ? {} : current),
        runnerOutput: result.output,
        runnerFinal: isFinalOutput(result.output),
        runnerExitCode: result.exitCode,
      }));
    } catch {}
  }
}

main().catch(() => {});
