/** Owns the canonical dispatcher command because the 2026-09-23 TradeForge and 2026-09-24 local incidents let haiku ignore its prompt and register two paid runs for one order id. */
import { CLI_NAMES } from './cli-names.mjs';
import {
  extractValue,
  isAbsoluteTaskFilePath,
  isInputPlaceholder,
  parseContinuationGrant,
  REQUIRED_INPUTS,
} from './required-inputs.mjs';
import { firstShellUnsafeSequence } from './shell-unsafe.mjs';

function refusal(reason) {
  return { refusal: `Refused: ${reason}.` };
}

function unsafeValueReason(value, label) {
  const sequence = firstShellUnsafeSequence(value);
  if (sequence !== null) return `input "${label}" contains unsafe shell sequence ${JSON.stringify(sequence)}`;
  if (value.includes('"') || value.includes('\r') || value.includes('\n')) {
    return `input "${label}" contains a double quote or line break`;
  }
  return null;
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

  const inputs = new Map();
  for (const entry of REQUIRED_INPUTS[agentType]) {
    if (entry.conditional) continue;
    const value = extractValue(promptText, entry.label);
    if (isInputPlaceholder(value, entry.label)) {
      return refusal(`required input "${entry.label}" is missing or is a placeholder`);
    }
    const unsafe = unsafeValueReason(value, entry.label);
    if (unsafe) return refusal(unsafe);
    if (entry.label === 'task file' && !isAbsoluteTaskFilePath(value)) {
      return refusal('input "task file" must be an absolute path');
    }
    inputs.set(entry.label, value);
  }

  // The continuation grant never reaches the command line (`--continue` is bare), so its free-text
  // reason is not screened: the live grant "…five risks; advise settles them" would have been refused.
  const optionalLabels = ['repository', 'scope new', 'slug', 'effort'];
  for (const label of optionalLabels) {
    const value = extractValue(promptText, label);
    if (value === null) continue;
    const unsafe = unsafeValueReason(value, label);
    if (unsafe) return refusal(unsafe);
    inputs.set(label, value);
  }

  const tokens = [CLI_NAMES[0], 'run', '--agent', agentType, '--repo', quote(inputs.get('repository') || '.')];
  if (agentType === 'codex-advisor') tokens.push('--phase', quote(inputs.get('phase')));
  if (agentType === 'codex-build') {
    tokens.push('--scope', quote(inputs.get('scope')));
    if (inputs.get('scope new')) tokens.push('--scope-new', quote(inputs.get('scope new')));
  }
  if (inputs.get('slug')) tokens.push('--slug', quote(inputs.get('slug')));
  tokens.push('--order-id', quote(inputs.get('order id')));
  tokens.push('--task-file', quote(inputs.get('task file')));
  if (inputs.get('effort')) tokens.push('--effort', quote(inputs.get('effort')));
  if (parseContinuationGrant(promptText)) tokens.push('--continue');
  return { command: tokens.join(' ') };
}

/** Compares the proposed command as text, allowing whitespace only around its boundary. */
export function sameCommand(candidate, canonical) {
  return typeof candidate === 'string' && typeof canonical === 'string' && candidate.trim() === canonical;
}
