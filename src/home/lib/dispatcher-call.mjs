/**
 * Parses and explains dispatcher calls using only the shared registry's exact label lines.
 * Plan_76 D1: on 2026-10-04 scope-new was dropped or read as scope, and repository prose caused a cd prefix.
 */
import {
  OPTIONAL_INPUTS,
  REQUIRED_INPUTS,
  callInputsFor,
  isAbsoluteTaskFilePath,
  isInputPlaceholder,
} from './required-inputs.mjs';
import { firstShellUnsafeSequence } from './shell-unsafe.mjs';

const knownLabels = new Set([
  ...Object.values(REQUIRED_INPUTS).flat(),
  ...OPTIONAL_INPUTS,
].map((entry) => entry.label));

const freeTextReason = 'not a `label: value` line; free text belongs in the task file';

function normaliseLabel(label) {
  return label.toLowerCase().replace(/^[-*] /, '').replace(/[*`]/g, '')
    .replace(/^_+|_+$/g, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

function unsafeSequence(value) {
  const shell = firstShellUnsafeSequence(value);
  const other = value.match(/["\r\n]/)?.[0] ?? null;
  if (shell === null) return other;
  if (other === null) return shell;
  return value.indexOf(shell) <= value.indexOf(other) ? shell : other;
}

/** Returns the accepted label values and every refusal; one reader for the gate, the command and the transcript. */
export function parseDispatcherCall(agentType, promptText) {
  const entries = callInputsFor(agentType);
  const labels = new Set(entries.map((entry) => entry.label));
  const inputs = new Map();
  const problems = [];
  const acceptedLines = new Map();

  promptText.split(/\r?\n/).forEach((text, index) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const line = index + 1;
    const colon = trimmed.indexOf(':');
    const label = colon === -1 ? null : trimmed.slice(0, colon);
    const tail = colon === -1 ? '' : trimmed.slice(colon + 1);
    const value = tail.trim();

    if (labels.has(label) && !value) {
      problems.push({ line, text, reason: `label \`${label}\` has an empty value` });
      return;
    }
    if (labels.has(label) && /^[ \t]+/.test(tail)) {
      if (inputs.has(label)) {
        const first = acceptedLines.get(label).line;
        problems.push({ line, text, reason: `label \`${label}\` is given twice (line ${first} and line ${line})` });
        return;
      }
      inputs.set(label, value);
      acceptedLines.set(label, { line, text });
      return;
    }

    const normalised = label === null ? null : normaliseLabel(label);
    let reason = freeTextReason;
    if (labels.has(normalised)) {
      reason = `write the label exactly as \`${normalised}:\``;
    } else if (knownLabels.has(normalised)) {
      reason = `label \`${normalised}\` is not accepted by \`${agentType}\``;
    }
    problems.push({ line, text, reason });
  });

  for (const entry of entries) {
    if (!entry.conditional && !entry.optional && !inputs.has(entry.label)) {
      problems.push({ line: null, text: '', reason: `missing required label \`${entry.label}\`` });
    }
  }
  for (const [label, value] of inputs) {
    // The runner owns grant refusals; grant prose never reaches a command-line value (Plan_76 D1).
    if (label === 'continue' || label === 'retry') continue;
    const location = acceptedLines.get(label);
    if (isInputPlaceholder(value, label)) {
      problems.push({ ...location, reason: `label \`${label}\` is still a placeholder` });
    }
    if (label === 'task file' && !isAbsoluteTaskFilePath(value)) {
      problems.push({ ...location, reason: 'label `task file` must be an absolute path' });
    }
    const sequence = unsafeSequence(value);
    if (sequence !== null) {
      const reason = `label \`${label}\` contains ${JSON.stringify(sequence)}; put free text in the task file`;
      problems.push({ ...location, reason });
    }
  }
  return { inputs, problems };
}

/** Names each refused line and the agent's full label list, so one free refusal carries its own repair. */
export function renderCallRefusal(agentType, problems) {
  const lines = ['Order gate denied the Agent call: the call text must be only `label: value` lines.'];
  for (const { line, text, reason } of problems) {
    lines.push(line === null ? `- ${reason}` : `- line ${line}: \`${text}\` — ${reason}`);
  }
  const labels = callInputsFor(agentType).map((entry) => {
    const status = entry.optional ? 'optional' : entry.conditional || 'required';
    return `\`${entry.label}\` (${status})`;
  });
  lines.push(`Labels for ${agentType}: ${labels.join(', ')}`, 'Free text belongs in the task file.');
  return lines.join('\n');
}
