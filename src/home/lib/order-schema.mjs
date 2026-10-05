/**
 * Defines dispatcher orders from the existing input registry for task-file headers.
 * Plan_63 D1/D3: the 2026-10-04 `continue: none` regression requires one order schema,
 * rather than independently defined call labels and header grants.
 */
import { REQUIRED_INPUTS, callInputsFor, isInputPlaceholder } from './required-inputs.mjs';
import { firstShellUnsafeSequence } from './shell-unsafe.mjs';

export const ORDER_AGENTS = Object.freeze(Object.keys(REQUIRED_INPUTS));

const schemas = new Map(ORDER_AGENTS.map((agentType) => [agentType,
  Object.freeze(callInputsFor(agentType)
    .filter(({ label }) => label !== 'task file')
    .map(({ label, flag, conditional, optional, example }) => Object.freeze({
      label,
      flag,
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

const inputNames = new Map(ORDER_AGENTS.flatMap((agentType) =>
  orderLabelsFor(agentType).map(({ label, flag }) => [label, flag])));

// Plan_63 D7: switching the order input channel changes only this function.
export function orderInputName(label) {
  if (!inputNames.has(label)) throw new Error(`Unknown order input label "${label}"`);
  return `\`${label}:\``;
}

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
    // Plan_63 D5: the flag-era refusal (Plan_42) keeps its pair in the header — an order value is a short
    // identifier, so a shell sequence in it is free text written in the wrong place.
    const sequence = firstShellUnsafeSequence(value);
    if (sequence !== null) {
      problems.push({ ...location, reason: `${orderInputName(label)} contains forbidden shell sequence ` +
        `${JSON.stringify(sequence)}; put free text in the task file body and keep header values short` });
    }
    // Plan_63 D5: new paths cannot replace the existing-file boundary of a writing order.
    if (agentType === 'codex-build' && label === 'scope'
        && !value.split(',').some((pattern) => pattern.trim())) {
      problems.push({ ...location,
        reason: `${orderInputName(label)} is required for codex-build: declare at least one existing path pattern; ` +
          `${orderInputName('scope new')} does not replace it.` });
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
