/** Owns the canonical dispatcher command because the 2026-09-23 TradeForge and 2026-09-24 local incidents let haiku ignore its prompt and register two paid runs for one order id. */
import { CLI_NAMES } from './cli-names.mjs';
import { parseDispatcherCall } from './dispatcher-call.mjs';
import { REQUIRED_INPUTS } from './required-inputs.mjs';

function refusal(reason) {
  return { refusal: `Refused: ${reason}.` };
}

function quote(value) {
  return `"${value}"`;
}

/** Builds the only permitted run command directly from the immutable order transcript. */
export function canonicalRunCommand(agentType, promptText) {
  if (typeof agentType !== 'string' || !Object.prototype.hasOwnProperty.call(REQUIRED_INPUTS, agentType)) {
    return refusal(`unknown dispatcher agent ${JSON.stringify(agentType)}`);
  }
  if (typeof promptText !== 'string') return refusal('prompt text is missing or is not text');

  // Plan_76 D1: the strict shared parser prevents scope-new from becoming a scope value.
  const { inputs, problems } = parseDispatcherCall(agentType, promptText);
  if (problems.length) {
    const reasons = problems.map(({ line, reason }) => line === null ? reason : `line ${line}: ${reason}`);
    return refusal(`the call text must be only label: value lines: ${reasons.join('; ')}`);
  }

  const tokens = [CLI_NAMES[0], 'run', '--agent', agentType, '--repo', quote(inputs.get('repository') || '.')];
  if (agentType === 'codex-review' && inputs.has('changeset')) {
    tokens.push('--changeset', quote(inputs.get('changeset')));
  }
  if (agentType === 'codex-advisor') tokens.push('--phase', quote(inputs.get('phase')));
  if (agentType === 'codex-build') {
    tokens.push('--scope', quote(inputs.get('scope')));
    if (inputs.get('scope new')) tokens.push('--scope-new', quote(inputs.get('scope new')));
  }
  if (inputs.get('slug')) tokens.push('--slug', quote(inputs.get('slug')));
  tokens.push('--order-id', quote(inputs.get('order id')));
  tokens.push('--task-file', quote(inputs.get('task file')));
  if (inputs.get('effort')) tokens.push('--effort', quote(inputs.get('effort')));
  // Plan_75 D1, TradeForge capacity incident: forward either grant; the runner owns conflicting-grant refusal.
  if (inputs.has('continue') || inputs.has('retry')) tokens.push('--continue');
  return { command: tokens.join(' ') };
}

/** Compares the proposed command as text, allowing whitespace only around its boundary. */
export function sameCommand(candidate, canonical) {
  return typeof candidate === 'string' && typeof canonical === 'string' && candidate.trim() === canonical;
}
