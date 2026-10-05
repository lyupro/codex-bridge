/**
 * Owns the dispatcher order registry for task-file headers.
 * Plan_63 D9: the call carries only task file, so order entries belong here without runner flags.
 * The D1/D3 `continue: none` regression still requires one schema for all header readers.
 */
import { isInputPlaceholder } from './order-values.mjs';
import { firstShellUnsafeSequence } from './shell-unsafe.mjs';

const freezeEntries = (entries) => Object.freeze(entries.map((entry) => Object.freeze(entry)));

export const CONTINUATION_ORDER_INPUT = Object.freeze({
  label: 'continue',
  explanation:
    'The run folder this pass is ordered to continue, followed by why the orchestrator is spending another pass. A continuation is assigned by the orchestrator; after a verdict, the dispatcher returns it and stops.',
  example: '2026-08-05_092913_plan14-build — LIMIT at step 3, tests unwritten',
  conditional: 'when this pass continues or repeats a named run',
});

export const RETRY_ORDER_INPUT = Object.freeze({
  label: 'retry',
  explanation:
    'The failed run this pass repeats, followed by why the orchestrator pays for the same pass again. A retry repeats that failed pass under its own order; it does not authorize the next pass.',
  example: '2026-10-03_172017_cc-d66-advisor — model at capacity, same pass again',
  conditional: 'when this pass continues or repeats a named run',
});

const REQUIRED_ORDER_INPUTS = Object.freeze({
  'codex-scout': freezeEntries([
    {
      label: 'order id',
      explanation: 'The label this order is known by. Repeating a call with the same label joins the run already in flight and costs no quota; a different piece of work needs a new label, never a reused one.',
      example: 'plan-13-scout-20260804',
    },
    CONTINUATION_ORDER_INPUT,
    RETRY_ORDER_INPUT,
  ]),
  'codex-build': freezeEntries([
    {
      label: 'order id',
      explanation: 'The label this order is known by. Repeating a call with the same label joins the run already in flight and costs no quota; a different piece of work needs a new label, never a reused one.',
      example: 'plan-13-build-20260804',
    },
    {
      label: 'scope',
      explanation: 'Comma-separated globs relative to the repository root, listing every file the run may touch — including each caller of what changes, not only the file being edited. Anything outside the list fails the run.',
      example: 'src/home/lib/runner/**,tests/runner/**',
    },
    CONTINUATION_ORDER_INPUT,
    RETRY_ORDER_INPUT,
  ]),
  'codex-review': freezeEntries([
    {
      label: 'order id',
      explanation: 'The label this order is known by. Repeating a call with the same label joins the run already in flight and costs no quota; a different piece of work needs a new label, never a reused one.',
      example: 'plan-13-review-20260804',
    },
    CONTINUATION_ORDER_INPUT,
    RETRY_ORDER_INPUT,
  ]),
  // Plan_59 D7: the caller must name the phase and authorize the continued decision pass.
  'codex-advisor': freezeEntries([
    {
      label: 'order id',
      explanation: 'The label this design order is known by. Keep the same order id for scope and advise so phase 2 can settle the risks predicted in phase 1.',
      example: 'plan-59-advisor-20260922',
    },
    CONTINUATION_ORDER_INPUT,
    RETRY_ORDER_INPUT,
    {
      label: 'phase',
      explanation: 'Pass scope first to predict risks and check the reading boundary, then advise with a continue: grant naming the scope run of the same order.',
      example: 'scope',
    },
  ]),
});

export const ORDER_AGENTS = Object.freeze(Object.keys(REQUIRED_ORDER_INPUTS));

const OPTIONAL_ORDER_INPUTS = freezeEntries([
  {
    label: 'repository',
    agents: ORDER_AGENTS,
    explanation: 'The repository the runner works in. Pass its path as a labelled value so the dispatcher needs no cd.',
    example: 'C:/work/codex-bridge',
  },
  {
    label: 'scope new',
    agents: Object.freeze(['codex-build']),
    explanation: 'Comma-separated globs for new files this build may create, relative to the repository root.',
    example: 'src/home/lib/dispatcher-call.mjs,tests/dispatcher-call.test.mjs',
  },
  {
    label: 'slug',
    agents: ORDER_AGENTS,
    explanation: 'The readable name used for the run folder. It names this pass without replacing the order id.',
    example: 'plan-76-parser',
  },
  {
    label: 'effort',
    agents: ORDER_AGENTS,
    explanation: 'The reasoning effort assigned to this pass. The runner checks which effort values it accepts.',
    example: 'high',
  },
  {
    label: 'changeset',
    agents: Object.freeze(['codex-review']),
    explanation: 'The changes to review: uncommitted, base:<branch>, or commit:<sha>. Name only the ordered changeset.',
    example: 'base:main',
  },
]);

const schemas = new Map(ORDER_AGENTS.map((agentType) => [agentType,
  freezeEntries([
    ...REQUIRED_ORDER_INPUTS[agentType],
    ...OPTIONAL_ORDER_INPUTS.filter((entry) => entry.agents.includes(agentType))
      .map((entry) => ({ ...entry, optional: true })),
  ].map((entry) => ({
    ...entry,
    required: !entry.conditional && !entry.optional,
    conditional: Boolean(entry.conditional),
    optional: Boolean(entry.optional),
  }))),
]));
const NO_LABELS = Object.freeze([]);

export function orderLabelsFor(agentType) {
  return schemas.get(agentType) ?? NO_LABELS;
}

export const ALL_ORDER_LABELS = Object.freeze([...new Set(
  ORDER_AGENTS.flatMap((agentType) => orderLabelsFor(agentType).map(({ label }) => label)),
)].sort());

const inputNames = new Set(ALL_ORDER_LABELS);

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

export function renderOrderProblems(agentType, problems) {
  return [...problems.map(({ lineNo, line, reason }) => lineNo === null
    ? reason : `line ${lineNo}: ${reason}: ${line}`), renderOrderHeaderHelp(agentType)].join('\n');
}

export function renderOrderHeaderHelp(agentType) {
  const labels = orderLabelsFor(agentType);
  return [
    ...labels.filter(({ required }) => required),
    ...labels.filter(({ conditional }) => conditional),
    ...labels.filter(({ optional }) => optional),
  ].map(({ label, example }) => `${label}: ${example}`).join('\n');
}
