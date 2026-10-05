/** Owns the canonical dispatcher command because the 2026-09-23 TradeForge and 2026-09-24 local incidents let haiku ignore its prompt and register two paid runs for one order id. */
import { CLI_NAMES } from './cli-names.mjs';
import { parseDispatcherCall } from './dispatcher-call.mjs';
import { ORDER_AGENTS } from './order-schema.mjs';

function refusal(reason) {
  return { refusal: `Refused: ${reason}.` };
}

function assembleRunCommand(agentType, taskFile) {
  const tokens = [CLI_NAMES[0], 'run', '--agent', agentType, '--task-file', `"${taskFile}"`];
  return tokens.join(' ');
}

/** Plan_63 D11: prompt templates and the gate must use the same command assembler. */
export function renderRunCommandTemplate(agentType) {
  if (typeof agentType !== 'string' || !ORDER_AGENTS.includes(agentType)) {
    throw new Error(`unknown dispatcher agent ${JSON.stringify(agentType)}`);
  }
  return assembleRunCommand(agentType, '<task-file path from the orchestrator>');
}

/** Builds the only permitted run command directly from the immutable order transcript. */
export function canonicalRunCommand(agentType, promptText) {
  if (typeof agentType !== 'string' || !ORDER_AGENTS.includes(agentType)) {
    return refusal(`unknown dispatcher agent ${JSON.stringify(agentType)}`);
  }
  if (typeof promptText !== 'string') return refusal('prompt text is missing or is not text');

  // Plan_63 D9, OW-054: the call cannot switch continuation or bypass order ownership.
  const { inputs, problems } = parseDispatcherCall(agentType, promptText);
  if (problems.length) {
    const reasons = problems.map(({ line, reason }) => line === null ? reason : `line ${line}: ${reason}`);
    return refusal(`the call text must be only label: value lines: ${reasons.join('; ')}`);
  }

  return { command: assembleRunCommand(agentType, inputs.get('task file')) };
}

/** Compares the proposed command as text, allowing whitespace only around its boundary. */
export function sameCommand(candidate, canonical) {
  return typeof candidate === 'string' && typeof canonical === 'string' && candidate.trim() === canonical;
}
