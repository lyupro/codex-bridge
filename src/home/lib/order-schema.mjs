/**
 * Defines dispatcher orders from the existing input registry for task-file headers.
 * Plan_63 D1/D3: the 2026-10-04 `continue: none` regression requires one order schema,
 * rather than independently defined call labels and header grants.
 */
import { REQUIRED_INPUTS, callInputsFor, isInputPlaceholder } from './required-inputs.mjs';

export const ORDER_AGENTS = Object.freeze(Object.keys(REQUIRED_INPUTS));

const schemas = new Map(ORDER_AGENTS.map((agentType) => [agentType,
  Object.freeze(callInputsFor(agentType)
    .filter(({ label }) => label !== 'task file')
    .map(({ label, conditional, optional, example }) => Object.freeze({
      label,
      required: !conditional && !optional,
      conditional: Boolean(conditional),
      optional: Boolean(optional),
      example,
    }))),
]));
const NO_LABELS = Object.freeze([]);

export function orderLabelsFor(agentType) {
  return schemas.get(agentType) ?? NO_LABELS;
}

export const ALL_ORDER_LABELS = Object.freeze([...new Set(
  ORDER_AGENTS.flatMap((agentType) => orderLabelsFor(agentType).map(({ label }) => label)),
)].sort());

export function orderFromHeader(agentType, parsed) {
  const order = new Map();
  const problems = [];
  if (!schemas.has(agentType)) {
    problems.push({ lineNo: null, line: '', reason: `unknown dispatcher agent "${agentType}"` });
    return { order, problems };
  }

  const labels = orderLabelsFor(agentType);
  const accepted = new Set(labels.map(({ label }) => label));
  for (const [label, value] of Object.entries(parsed.fields)) {
    if (!ALL_ORDER_LABELS.includes(label)) continue;
    // parseTaskHeader retains the first duplicate value; diagnostics must name that same line.
    const entry = parsed.entries?.find((entry) => entry.label === label);
    const location = entry ? { lineNo: entry.lineNo, line: entry.line }
      : { lineNo: null, line: '' };
    if (!accepted.has(label)) {
      problems.push({ ...location, reason: `label "${label}" is not accepted by ${agentType}` });
      continue;
    }
    // Grant values are validated by parseTaskHeader; re-reporting them would duplicate its problem.
    if (label === 'continue' || label === 'retry') continue;
    order.set(label, value);
    if (isInputPlaceholder(value, label)) {
      problems.push({ ...location, reason: `label "${label}" is still a placeholder` });
    }
  }
  for (const { label, required, example } of labels) {
    if (required && !Object.hasOwn(parsed.fields, label)) {
      problems.push({ lineNo: null, line: '',
        reason: `missing required header label "${label}:"; example: ${label}: ${example}` });
    }
  }
  return { order, problems };
}

export function renderOrderHeaderHelp(agentType) {
  const labels = orderLabelsFor(agentType);
  return [
    ...labels.filter(({ required }) => required),
    ...labels.filter(({ conditional }) => conditional),
    ...labels.filter(({ optional }) => optional),
  ].map(({ label, example }) => `${label}: ${example}`).join('\n');
}
