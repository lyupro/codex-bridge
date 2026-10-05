/**
 * Owns the task-file-only dispatcher call and its repair instructions.
 * Plan_63 D1/D9, OW-054: order labels in the call must never become runner flags.
 */
import {
  ALL_ORDER_LABELS,
  CONTINUATION_ORDER_INPUT,
  ORDER_AGENTS,
  RETRY_ORDER_INPUT,
  orderLabelsFor,
  renderOrderHeaderHelp,
} from './order-schema.mjs';
import {
  isAbsoluteTaskFilePath,
  isInputPlaceholder,
} from './order-values.mjs';
import { firstShellUnsafeSequence } from './shell-unsafe.mjs';

export const TASK_FILE_INPUT = Object.freeze({
  label: 'task file',
  explanation: 'Absolute path to a file holding the task statement verbatim, written by the orchestrator with its file tool. The dispatcher passes the path to the runner and never creates, reads or rewrites the file: writing it from the shell reintroduces the permission prompt this file channel exists to remove. Given no path, return the refusal.',
  example: 'C:/Users/me/AppData/Local/Temp/claude/<session>/scratchpad/task-plan-13.md',
});

export function callInputsFor(agentType) {
  return ORDER_AGENTS.includes(agentType) ? [TASK_FILE_INPUT] : [];
}

const knownLabels = new Set(ALL_ORDER_LABELS);

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

// Review of 4ed0fd4: the command quotes the path in double quotes, where Bash still expands `$NAME`,
// folds `\\` into `\` and lets a final `\` escape the closing quote. The gate would validate the
// literal file while the runner opened another, so any such path is refused, not escaped.
function shellRewrittenSequence(value) {
  return value.match(/\$|\\\\|\\$/)?.[0] ?? null;
}

function shellRewrittenReason(label, sequence) {
  return `label \`${label}\` contains ${JSON.stringify(sequence)}, which the shell rewrites inside double quotes; `
    + 'write the path with forward slashes and without `$`';
}

/** Returns the accepted label values and every refusal; one reader for the gate, the command and the transcript. */
export function parseDispatcherCall(agentType, promptText) {
  const entries = callInputsFor(agentType);
  const labels = new Set(entries.map((entry) => entry.label));
  const inputs = new Map();
  const problems = [];
  const acceptedLines = new Map();

  if (!ORDER_AGENTS.includes(agentType)) {
    problems.push({ line: null, text: '', reason: `unknown dispatcher agent ${JSON.stringify(agentType)}` });
    return { inputs, problems };
  }

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
      reason = `label \`${normalised}\` moved to the task-file header; the call is only \`task file: <absolute path>\``;
    }
    problems.push({ line, text, reason });
  });

  for (const entry of entries) {
    if (!entry.conditional && !entry.optional && !inputs.has(entry.label)) {
      problems.push({ line: null, text: '', label: entry.label, reason: `missing required label \`${entry.label}\`` });
    }
  }
  for (const [label, value] of inputs) {
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
    } else {
      const expanding = shellRewrittenSequence(value);
      if (expanding !== null) problems.push({ ...location, reason: shellRewrittenReason(label, expanding) });
    }
  }
  return { inputs, problems };
}

/** Names each refused line and the agent's header template, so one free refusal carries its own repair. */
export function renderCallRefusal(agentType, problems) {
  const lines = ['Order gate denied the Agent call: the call text must be only `label: value` lines.'];
  const entries = callInputsFor(agentType);
  for (const { line, text, reason, label } of problems) {
    const entry = line === null && reason === `missing required label \`${label}\``
      ? entries.find((entry) => entry.label === label) : undefined;
    const detail = entry ? ` — ${entry.explanation} Example: \`${entry.label}: ${entry.example}\`.` : '';
    lines.push(line === null ? `- ${reason}${detail}` : `- line ${line}: \`${text}\` — ${reason}`);
  }
  lines.push('The call is only `task file: <absolute path>`.',
    'The order goes in the header at the top of that file:',
    ...renderOrderHeaderHelp(agentType).split('\n'), 'Free text belongs in the task file.');
  return lines.join('\n');
}

function headerInputsFor(agentType) {
  const entries = orderLabelsFor(agentType);
  return [
    ...entries.filter(({ required }) => required),
    ...entries.filter(({ conditional }) => conditional),
    ...entries.filter(({ optional }) => optional),
  ];
}

function conditionFor(entry) {
  return [CONTINUATION_ORDER_INPUT, RETRY_ORDER_INPUT]
    .find(({ label }) => label === entry.label)?.conditional;
}

/** Keeps the caller's short prompt aligned with the header registry, including grant conditions. */
export function renderRequiredInputSummary(agentType) {
  if (!ORDER_AGENTS.includes(agentType)) return '';
  const entries = headerInputsFor(agentType);
  const required = entries.filter(({ required }) => required).map(({ label }) => `\`${label}\``);
  const conditional = entries.filter(({ conditional }) => conditional)
    .map((entry) => `\`${entry.label}\` (${conditionFor(entry)})`);
  const optional = entries.filter(({ optional }) => optional).map(({ label }) => `\`${label}\``);
  return `The call is only \`task file\` (an absolute path). The task-file header requires ${required.join(', ')}; `
    + `conditional labels: ${conditional.join(', ')}; optional labels: ${optional.join(', ')}. `
    + 'Free text belongs in the task file.';
}
