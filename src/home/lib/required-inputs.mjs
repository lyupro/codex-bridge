import path from 'node:path';
import { firstShellUnsafeSequence } from './shell-unsafe.mjs';

/**
 * Defines the inputs the orchestrator must give each Codex dispatcher.
 *
 * This contract belongs beside the gate because the dispatcher prompt was the only place that
 * named order id and scope, so the caller launched codex-build without either value and the
 * runner refused the call before Codex could do any work. Pass 2 can render the same entries
 * into agent instructions without creating a second list that can drift.
 */

const PLACEHOLDER_VALUES = new Set(['todo', 'tbd', 'label', 'none', 'order id', 'scope', 'xxx']);

const freezeEntries = (entries) => Object.freeze(entries.map((entry) => Object.freeze(entry)));

export const CONTINUATION_INPUT = Object.freeze({
  label: 'continue',
  flag: '--continue',
  source: 'the orchestrator',
  explanation:
    'The run folder this pass is ordered to continue, followed by why the orchestrator is spending another pass. A continuation is assigned by the orchestrator; after a verdict, the dispatcher returns it and stops.',
  example: '2026-08-05_092913_plan14-build — LIMIT at step 3, tests unwritten',
  conditional: 'when --continue is passed',
});

export const RETRY_INPUT = Object.freeze({
  label: 'retry',
  flag: '--continue',
  source: 'the orchestrator',
  explanation:
    'The failed run this pass repeats, followed by why the orchestrator pays for the same pass again. A retry repeats that failed pass under its own order; it does not authorize the next pass.',
  example: '2026-10-03_172017_cc-d66-advisor — model at capacity, same pass again',
  conditional: 'when --continue is passed',
});

/**
 * The task statement reaches the runner as a file because every other channel puts the invocation
 * back into the multi-line form that no permission rule can cover — a heredoc on stdin, or a
 * quoted argument the shell mangles. The orchestrator writes that file with its own file tool,
 * which never crosses the shell at all.
 *
 * It is listed as a required input, not merely explained in the prompt body, because the rendered
 * summary is the ONLY part of this contract the orchestrator ever reads. Left out of the list, a
 * dispatcher that was given no path filled the gap itself: on 2026-08-15 codex-build wrote the file
 * with `cat > … << 'EOF'` and earned exactly the permission window the file was introduced to end.
 * The 2026-08-15 relative-path incident also made the repository cwd silently choose a different
 * task.md, so both the producer gate and runner use this cross-platform absolute-path contract.
 */
export const TASK_FILE_INPUT = Object.freeze({
  label: 'task file',
  flag: '--task-file',
  source: 'the orchestrator',
  explanation: 'Absolute path to a file holding the task statement verbatim, written by the orchestrator with its file tool. The dispatcher passes it as --task-file and never creates, reads or rewrites it: writing it from the shell reintroduces the permission prompt this flag exists to remove. Given no path, start the runner without the flag and return its refusal.',
  example: 'C:/Users/me/AppData/Local/Temp/claude/<session>/scratchpad/task-plan-13.md',
});

export const REQUIRED_INPUTS = Object.freeze({
  'codex-scout': freezeEntries([
    {
      label: 'order id',
      flag: '--order-id',
      source: 'the orchestrator',
      explanation: 'The label this order is known by. Repeating a call with the same label joins the run already in flight and costs no quota; a different piece of work needs a new label, never a reused one.',
      example: 'plan-13-scout-20260804',
    },
    TASK_FILE_INPUT,
    CONTINUATION_INPUT,
    RETRY_INPUT,
  ]),
  'codex-build': freezeEntries([
    {
      label: 'order id',
      flag: '--order-id',
      source: 'the orchestrator',
      explanation: 'The label this order is known by. Repeating a call with the same label joins the run already in flight and costs no quota; a different piece of work needs a new label, never a reused one.',
      example: 'plan-13-build-20260804',
    },
    {
      label: 'scope',
      flag: '--scope',
      source: 'the orchestrator',
      explanation: 'Comma-separated globs relative to the repository root, listing every file the run may touch — including each caller of what changes, not only the file being edited. Anything outside the list fails the run.',
      example: 'src/home/lib/runner/**,tests/runner/**',
    },
    TASK_FILE_INPUT,
    CONTINUATION_INPUT,
    RETRY_INPUT,
  ]),
  'codex-review': freezeEntries([
    {
      label: 'order id',
      flag: '--order-id',
      source: 'the orchestrator',
      explanation: 'The label this order is known by. Repeating a call with the same label joins the run already in flight and costs no quota; a different piece of work needs a new label, never a reused one.',
      example: 'plan-13-review-20260804',
    },
    TASK_FILE_INPUT,
    CONTINUATION_INPUT,
    RETRY_INPUT,
  ]),
  // Plan_59 D7: the caller must name the phase and authorize the continued decision pass.
  'codex-advisor': freezeEntries([
    {
      label: 'order id',
      flag: '--order-id',
      source: 'the orchestrator',
      explanation: 'The label this design order is known by. Keep the same order id for scope and advise so phase 2 can settle the risks predicted in phase 1.',
      example: 'plan-59-advisor-20260922',
    },
    TASK_FILE_INPUT,
    CONTINUATION_INPUT,
    RETRY_INPUT,
    {
      label: 'phase',
      flag: '--phase',
      source: 'the orchestrator',
      explanation: 'Pass scope first to predict risks and check the reading boundary, then advise with --continue and a continuation grant naming the scope run of the same order.',
      example: 'scope',
    },
  ]),
});

const allDispatcherAgents = Object.freeze(Object.keys(REQUIRED_INPUTS));

export const OPTIONAL_INPUTS = freezeEntries([
  {
    label: 'repository',
    agents: allDispatcherAgents,
    flag: '--repo',
    source: 'the orchestrator',
    explanation: 'The repository the runner works in. Pass its path as a labelled value so the dispatcher needs no cd.',
    example: 'C:/work/codex-bridge',
  },
  {
    label: 'scope new',
    agents: Object.freeze(['codex-build']),
    flag: '--scope-new',
    source: 'the orchestrator',
    explanation: 'Comma-separated globs for new files this build may create, relative to the repository root.',
    example: 'src/home/lib/dispatcher-call.mjs,tests/dispatcher-call.test.mjs',
  },
  {
    label: 'slug',
    agents: allDispatcherAgents,
    flag: '--slug',
    source: 'the orchestrator',
    explanation: 'The readable name used for the run folder. It names this pass without replacing the order id.',
    example: 'plan-76-parser',
  },
  {
    label: 'effort',
    agents: allDispatcherAgents,
    flag: '--effort',
    source: 'the orchestrator',
    explanation: 'The reasoning effort assigned to this pass. The runner checks which effort values it accepts.',
    example: 'high',
  },
  {
    label: 'changeset',
    agents: Object.freeze(['codex-review']),
    flag: '--changeset',
    source: 'the orchestrator',
    explanation: 'The changes to review: uncommitted, base:<branch>, or commit:<sha>. Name only the ordered changeset.',
    example: 'base:main',
  },
]);

/** Returns the single label registry for required, conditional and optional dispatcher inputs. */
export function callInputsFor(agentType) {
  if (!Object.hasOwn(REQUIRED_INPUTS, agentType)) return [];
  return [
    ...requiredInputsFor(agentType),
    ...OPTIONAL_INPUTS.filter((entry) => entry.agents.includes(agentType))
      .map((entry) => Object.freeze({ ...entry, optional: true })),
  ];
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function cleanValue(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^([`'\"])(.*)\1$/, '$2').trim();
}

export function isAbsoluteTaskFilePath(value) {
  const cleaned = cleanValue(value);
  return path.posix.isAbsolute(cleaned) || path.win32.isAbsolute(cleaned);
}

export function isPlaceholder(value) {
  const cleaned = cleanValue(value);
  if (!cleaned) return true;
  if (cleaned.startsWith('<') && cleaned.endsWith('>')) return true;
  return PLACEHOLDER_VALUES.has(cleaned.replace(/[.,;:]+$/, '').trim().toLowerCase());
}

// Plan_59: scope is a real phase value, while it remains a placeholder for existing inputs. Plan_63 D5: none is a
// real reasoning effort the flag channel always accepted, so the header channel must not refuse it as a template.
const REAL_VALUES = Object.freeze({ phase: 'scope', effort: 'none' });
export const isInputPlaceholder = (value, label) =>
  !(Object.hasOwn(REAL_VALUES, label) && cleanValue(value) === REAL_VALUES[label]) && isPlaceholder(value);

// Plan_75 D5: dispatcher prompts still need one spelling of a labelled line for reading values.
const labelledLine = (label) => {
  const labelPattern = escapeRegExp(label).replaceAll('\\ ', '\\s+');
  return `(?:[-*]\\s*)?(?:[*_` + '`' + `]?${labelPattern}[*_` + '`' + `]?)\\s*(?::|=|—|-)`;
};

export function extractValue(promptText, label) {
  const flag = `--${label.replaceAll(/\s+/g, '-')}`;
  const direct = new RegExp(`(?:^|\\r?\\n)\\s*${labelledLine(label)}\\s*([^\\r\\n]*)`, 'im');
  const directMatch = promptText.match(direct);
  if (directMatch) return cleanValue(directMatch[1]);

  const flagPattern = new RegExp(
    `${escapeRegExp(flag)}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s\\r\\n]+))`,
    'i',
  );
  const flagMatch = promptText.match(flagPattern);
  if (!flagMatch) return null;
  return cleanValue(flagMatch[1] ?? flagMatch[2] ?? flagMatch[3]);
}

const MAX_DIAGNOSIS_LINE_LENGTH = 160;

function readableDiagnosisLine(line) {
  const trimmed = line.trim();
  if (trimmed.length <= MAX_DIAGNOSIS_LINE_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_DIAGNOSIS_LINE_LENGTH - 1)}…`;
}

/** Explains the Plan_28 incident without widening the strict input parser's accepted spellings. */
export function diagnoseInput(promptText, label) {
  if (typeof label !== 'string' || !label.trim()) return null;
  const prompt = typeof promptText === 'string' ? promptText : '';
  const labelPattern = escapeRegExp(label).replaceAll('\\ ', '\\s+');
  const candidatePattern = new RegExp(
    `^[ \\t]*(?:[-*][ \\t]*)?(?:[*_` + '`' + `]?${labelPattern}[*_` + '`' + `]?)(?=$|[^A-Za-z0-9_])[^\\r\\n]*`,
    'i',
  );
  const candidateLine = prompt.split(/\r?\n/).find((line) => candidatePattern.test(line));
  if (candidateLine === undefined) return null;

  const value = extractValue(candidateLine, label);
  if (value !== null && !isInputPlaceholder(value, label)) {
    if (label === TASK_FILE_INPUT.label && !isAbsoluteTaskFilePath(value)) {
      return { line: readableDiagnosisLine(candidateLine), reason: `value \`${value}\` is not an absolute path` };
    }
    return null;
  }

  const line = readableDiagnosisLine(candidateLine);
  if (value !== null && isInputPlaceholder(value, label)) {
    const displayedValue = value.trim();
    if (!displayedValue) return { line, reason: 'value is empty; replace it with a concrete value' };
    return {
      line,
      reason: `value \`${displayedValue}\` is a placeholder; replace it with a concrete value`,
    };
  }

  const labelTail = candidateLine.match(
    new RegExp(`^[ \\t]*(?:[-*][ \\t]*)?(?:[*_` + '`' + `]?${labelPattern}[*_` + '`' + `]?)([^\\r\\n]*)$`, 'i'),
  )?.[1] ?? '';
  if (labelTail.includes(':')) {
    return { line, reason: `expected \`${label}:\` with nothing between the label and the colon` };
  }
  return { line, reason: `expected \`${label}: value\` with a separator immediately after the label` };
}

// Plan_75 D1, TradeForge capacity incident (2026-10-03): both grants need the same run/reason grammar.
function parseLabelledGrant(promptText, label) {
  const prompt = typeof promptText === 'string' ? promptText : '';
  const value = extractValue(prompt, label);
  return splitGrantValue(value);
}

// Plan_75 D5, 2026-10-03 20:42: header parsing must reuse the existing grant value grammar.
export function splitGrantValue(value) {
  if (isPlaceholder(value)) return null;

  for (const separator of [/\s+—\s+/, /\s+-\s+/, /\s*:\s*/]) {
    const match = value.match(new RegExp(`^(.+?)${separator.source}(.+)$`));
    if (!match) continue;
    const run = cleanValue(match[1]);
    const reason = cleanValue(match[2]);
    if (isPlaceholder(run) || isPlaceholder(reason)) return null;
    return { run, reason };
  }
  return null;
}

/** Keeps the 2026-08-05 continuation incident's run and reason in the shared input parser. */
export function parseContinuationGrant(promptText) {
  return parseLabelledGrant(promptText, CONTINUATION_INPUT.label);
}

export function parseRetryGrant(promptText) {
  return parseLabelledGrant(promptText, RETRY_INPUT.label);
}

export function parseGrant(promptText) {
  const continuation = parseContinuationGrant(promptText);
  const retry = parseRetryGrant(promptText);
  if (continuation && retry) {
    return { error: 'exactly one grant per task: remove either the continue: or the retry: line' };
  }
  if (continuation) return { kind: 'continue', ...continuation };
  if (retry) return { kind: 'retry', ...retry };
  return null;
}

/** Returns the immutable input entries for one dispatcher type. */
export function requiredInputsFor(agentType) {
  return REQUIRED_INPUTS[agentType] || [];
}

/** Returns required entries whose value is absent or is still an obvious template placeholder. */
export function missingInputs(agentType, promptText) {
  const prompt = typeof promptText === 'string' ? promptText : '';
  return requiredInputsFor(agentType).filter((entry) => {
    if (entry.conditional) return false;
    const value = extractValue(prompt, entry.label);
    if (isInputPlaceholder(value, entry.label)) return true;
    return entry === TASK_FILE_INPUT && !isAbsoluteTaskFilePath(value);
  });
}

/** Finds labelled command-line values that would disable the host's standing permission. */
export function shellUnsafeInputs(agentType, promptText) {
  const prompt = typeof promptText === 'string' ? promptText : '';
  return requiredInputsFor(agentType).flatMap((entry) => {
    if (entry.conditional) return [];
    const value = extractValue(prompt, entry.label);
    if (value === null || isInputPlaceholder(value, entry.label)) return [];
    const sequence = firstShellUnsafeSequence(value);
    return sequence === null ? [] : [{ entry, sequence }];
  });
}

/** Renders the compact contract the orchestrator sees while choosing a dispatcher. */
export function renderRequiredInputSummary(agentType) {
  const entries = requiredInputsFor(agentType);
  if (!entries.length) return '';
  const labels = entries.map((entry) => {
    const label = `\`${entry.label}\``;
    return entry.conditional ? `${label} (${entry.conditional})` : label;
  });
  // Commas until the last pair: the list grew to three entries when the continuation grant
  // joined it, and "a and b and c" reads as a stutter in the description the orchestrator
  // sees while choosing a dispatcher.
  const rendered = labels.length > 1
    ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
    : labels[0];
  const optionalLabels = OPTIONAL_INPUTS.filter((entry) => entry.agents.includes(agentType))
    .map((entry) => `\`${entry.label}\``);
  const optionalRendered = optionalLabels.length > 1
    ? `${optionalLabels.slice(0, -1).join(', ')} and ${optionalLabels[optionalLabels.length - 1]}`
    : optionalLabels[0];
  return `Requires ${entries[0].source}-provided ${rendered}.`
    + ` The call is only \`label: value\` lines; optional labels: ${optionalRendered}.`
    + ' Free text belongs in the task file.';
}

/** Renders the same contract for pass 2 agent instructions. */
export function renderRequiredInputs(agentType) {
  const required = requiredInputsFor(agentType)
    .map((entry) => {
      const condition = entry.conditional ? ` Condition: ${entry.conditional}.` : '';
      return `- ${entry.label}: ${entry.explanation} Example: \`${entry.example}\`.${condition}`;
    })
    .join('\n');
  if (!required) return '';
  const optional = OPTIONAL_INPUTS.filter((entry) => entry.agents.includes(agentType))
    .map((entry) => `- ${entry.label} (optional): ${entry.explanation} Example: \`${entry.label}: ${entry.example}\`.`);
  return [required, ...optional,
    "The orchestrator's call holds only these `label: value` lines, one per line; "
      + 'the order gate refuses any other line before you start.',
  ].join('\n');
}
