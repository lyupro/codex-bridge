/**
 * Owns the task-file-only dispatcher call and its repair instructions.
 * Plan_63 D1/D9, OW-054: order labels in the call must never become runner flags.
 */
import {
  ALL_ORDER_LABELS,
  CONTINUATION_ORDER_INPUT,
  ORDER_AGENTS,
  RETRY_ORDER_INPUT,
  RESUME_ORDER_INPUT,
  orderLabelsFor,
  renderOrderHeaderHelp,
} from './order-schema.mjs';
import {
  isAbsoluteTaskFilePath,
  isInputPlaceholder,
} from './order-values.mjs';
import { firstShellUnsafeSequence } from './shell-unsafe.mjs';
import { orderRuleMessage } from './order-rules.mjs';
import { orderDiagnosticMessage } from './order-diagnostics.mjs';

export const TASK_FILE_INPUT = Object.freeze({
  label: 'task file',
  explanation: orderRuleMessage('dispatcher-task-file-help'),
  example: 'C:/Users/me/AppData/Local/Temp/claude/<session>/scratchpad/task-plan-13.md',
});

export function callInputsFor(agentType) {
  return ORDER_AGENTS.includes(agentType) ? [TASK_FILE_INPUT] : [];
}

const knownLabels = new Set(ALL_ORDER_LABELS);

const freeTextReason = orderRuleMessage('dispatcher-call-shape', { violation: 'free-text' });

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
  return orderRuleMessage('dispatcher-call-shape', { violation: 'rewritten', label, sequence });
}

/** Returns the accepted label values and every refusal; one reader for the gate, the command and the transcript. */
export function parseDispatcherCall(agentType, promptText) {
  const entries = callInputsFor(agentType);
  const labels = new Set(entries.map((entry) => entry.label));
  const inputs = new Map();
  const problems = [];
  const acceptedLines = new Map();

  if (!ORDER_AGENTS.includes(agentType)) {
    problems.push({ line: null, text: '', reason: orderDiagnosticMessage('dispatcher-agent-input-known', { agentType }) });
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
      problems.push({ line, text, reason: orderRuleMessage('dispatcher-call-shape', { violation: 'empty', label }) });
      return;
    }
    if (labels.has(label) && /^[ \t]+/.test(tail)) {
      if (inputs.has(label)) {
        const first = acceptedLines.get(label).line;
        problems.push({ line, text, reason: orderRuleMessage('dispatcher-call-shape', { violation: 'duplicate', label, first, line }) });
        return;
      }
      inputs.set(label, value);
      acceptedLines.set(label, { line, text });
      return;
    }

    const normalised = label === null ? null : normaliseLabel(label);
    let reason = freeTextReason;
    if (labels.has(normalised)) {
      reason = orderRuleMessage('dispatcher-call-shape', { violation: 'spelling', label: normalised });
    } else if (knownLabels.has(normalised)) {
      reason = orderRuleMessage('dispatcher-call-shape', { violation: 'header', label: normalised });
    }
    problems.push({ line, text, reason });
  });

  for (const entry of entries) {
    if (!entry.conditional && !entry.optional && !inputs.has(entry.label)) {
      problems.push({ line: null, text: '', label: entry.label,
        reason: orderRuleMessage('dispatcher-call-shape', { violation: 'missing', label: entry.label }) });
    }
  }
  for (const [label, value] of inputs) {
    const location = acceptedLines.get(label);
    if (isInputPlaceholder(value, label)) {
      problems.push({ ...location, reason: orderRuleMessage('dispatcher-call-shape', { violation: 'placeholder', label }) });
    }
    if (label === 'task file' && !isAbsoluteTaskFilePath(value)) {
      problems.push({ ...location, reason: orderRuleMessage('dispatcher-call-shape', { violation: 'absolute' }) });
    }
    const sequence = unsafeSequence(value);
    if (sequence !== null) {
      const reason = orderRuleMessage('dispatcher-call-shape', { violation: 'unsafe', label, sequence });
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
  const lines = [orderRuleMessage('dispatcher-call-refusal', { part: 'intro' })];
  const entries = callInputsFor(agentType);
  for (const { line, text, reason, label } of problems) {
    const entry = line === null && reason === orderRuleMessage('dispatcher-call-shape', { violation: 'missing', label })
      ? entries.find((entry) => entry.label === label) : undefined;
    const detail = entry ? orderRuleMessage('dispatcher-call-refusal', {
      part: 'detail', explanation: entry.explanation, label: entry.label, example: entry.example,
    }) : '';
    lines.push(line === null ? orderRuleMessage('dispatcher-call-refusal', { part: 'problem', reason, detail })
      : orderRuleMessage('dispatcher-call-refusal', { part: 'line', line, text, reason }));
  }
  lines.push(orderRuleMessage('dispatcher-call-refusal', { part: 'call' }),
    orderRuleMessage('dispatcher-call-refusal', { part: 'header' }),
    ...renderOrderHeaderHelp(agentType).split('\n'), orderRuleMessage('dispatcher-call-refusal', { part: 'free-text' }));
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
  return [CONTINUATION_ORDER_INPUT, RETRY_ORDER_INPUT, RESUME_ORDER_INPUT]
    .find(({ label }) => label === entry.label)?.conditional;
}

/** Keeps the caller's short prompt aligned with the header registry, including grant conditions. */
export function renderRequiredInputSummary(agentType) {
  if (!ORDER_AGENTS.includes(agentType)) return orderRuleMessage('dispatcher-call-summary', { variant: 'unknown-agent' });
  const entries = headerInputsFor(agentType);
  const required = entries.filter(({ required }) => required).map(({ label }) => `\`${label}\``);
  const conditional = entries.filter(({ conditional }) => conditional)
    .map((entry) => `\`${entry.label}\` (${conditionFor(entry)})`);
  const optional = entries.filter(({ optional }) => optional).map(({ label }) => `\`${label}\``);
  return orderRuleMessage('dispatcher-call-summary', { variant: 'labels', required, conditional, optional });
}
