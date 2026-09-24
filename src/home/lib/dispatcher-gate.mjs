/** Holds dispatchers to the ordered runner because the 2026-09-23 TradeForge incident let one write and hand back without running it. */
import { canonicalRunCommand, sameCommand } from './dispatcher-command.mjs';
import { ownTranscriptPath, transcriptPrompt } from './dispatcher-order.mjs';
import { HANDBACK_TOOL } from './hook-definitions.mjs';

export { HANDBACK_TOOL };

export function gateOrder(payload) {
  const transcriptPath = ownTranscriptPath(payload);
  const prompt = transcriptPath ? transcriptPrompt(transcriptPath) : null;
  if (!transcriptPath || !prompt) {
    return {
      refusal: `the order could not be read from the agent transcript ${transcriptPath || '(none)'}`,
    };
  }
  return canonicalRunCommand(payload.agent_type, prompt);
}

export function runnerOutput(payload) {
  if (payload?.hook_event_name === 'PostToolUse') {
    const output = payload.tool_response?.stdout;
    return typeof output === 'string' && output.length > 0 ? { output, exitCode: 0 } : null;
  }
  if (payload?.hook_event_name !== 'PostToolUseFailure' || typeof payload.error !== 'string'
    || payload.error.length === 0) return null;

  const newline = payload.error.indexOf('\n');
  const firstLine = (newline < 0 ? payload.error : payload.error.slice(0, newline)).replace(/\r$/, '');
  const match = /^Exit code (\d+)$/.exec(firstLine);
  const output = match ? (newline < 0 ? '' : payload.error.slice(newline + 1)) : payload.error;
  return output.length > 0 ? { output, exitCode: match ? Number(match[1]) : null } : null;
}

export function isFinalOutput(output) {
  return !output.split(/\r?\n/).some((line) => line.startsWith('STARTED '));
}

function denial(message, order) {
  const prefix = `codex-bridge dispatcher gate: ${message}`;
  if (typeof order?.command !== 'string' || order.command.length === 0) return prefix;
  return `${prefix}\n${order.command}\nRun it exactly, in the foreground; repeating it attaches to the same run.`;
}

function deny(message, order, stateUpdate) {
  const decision = { kind: 'deny', reason: denial(message, order) };
  if (stateUpdate) decision.stateUpdate = stateUpdate;
  return decision;
}

function allow(message) {
  return { kind: 'allow', message, stateUpdate: { handback: 'delivered' } };
}

export function decidePreToolUse({ payload, order, state }) {
  const toolName = payload?.tool_name;
  // Once the caller holds the answer, the dispatcher is finished. On 2026-09-23 the real run was started
  // after the handback and wrote into a tree the caller believed settled; a substituted FAIL followed by a
  // late run would repeat exactly that, so nothing — not even the canonical command — runs past delivery.
  if (state?.handback === 'delivered') {
    return deny('the handback was already delivered; this dispatcher is finished and may not act further.');
  }
  if (toolName === 'Bash') {
    if (order?.refusal) {
      return deny('the order could not be read; nothing may run, so hand back now.', order);
    }
    if (order?.command && sameCommand(payload.tool_input?.command, order.command)
      && payload.tool_input?.run_in_background !== true) return { kind: 'pass' };
    return deny('only the canonical runner command may run in the foreground.', order);
  }

  if (toolName === HANDBACK_TOOL) {
    if (order?.refusal) return allow(`FAIL — dispatcher gate: ${order.refusal}`);
    if (typeof state?.runnerOutput === 'string' && state.runnerOutput.length > 0) {
      if (state.runnerFinal) return allow(state.runnerOutput);
      return deny('the run has started without a verdict; repeat the exact command to attach and wait.', order);
    }

    const attempts = Number.isInteger(state?.handbackAttempts) ? state.handbackAttempts : 0;
    const handbackAttempts = attempts + 1;
    if (handbackAttempts === 1) {
      return deny('the dispatcher handed back without a runner verdict; run the command first.', order,
        { handbackAttempts });
    }
    return {
      kind: 'allow',
      message: 'FAIL — dispatcher did not delegate: it handed back without running `' + order.command + '`',
      stateUpdate: { handbackAttempts, handback: 'delivered' },
    };
  }

  if (order?.refusal) {
    return deny('the order could not be read; nothing may run, so hand back now.', order);
  }
  return deny('only the canonical runner command may run before handback.', order);
}
