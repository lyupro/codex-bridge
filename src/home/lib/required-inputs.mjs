import path from 'node:path';

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
  source: 'the orchestrator',
  explanation:
    'The run folder this pass is ordered to continue, followed by why the orchestrator is spending another pass. A continuation is assigned by the orchestrator; after a verdict, the dispatcher returns it and stops.',
  example: '2026-08-05_092913_plan14-build — LIMIT at step 3, tests unwritten',
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
  source: 'the orchestrator',
  explanation: 'Absolute path to a file holding the task statement verbatim, written by the orchestrator with its file tool. The dispatcher passes it as --task-file and never creates, reads or rewrites it: writing it from the shell reintroduces the permission prompt this flag exists to remove. Given no path, start the runner without the flag and return its refusal.',
  example: 'C:/Users/me/AppData/Local/Temp/claude/<session>/scratchpad/task-plan-13.md',
});

export const REQUIRED_INPUTS = Object.freeze({
  'codex-scout': freezeEntries([
    {
      label: 'order id',
      source: 'the orchestrator',
      explanation: 'The label this order is known by. Repeating a call with the same label joins the run already in flight and costs no quota; a different piece of work needs a new label, never a reused one.',
      example: 'plan-13-scout-20260804',
    },
    TASK_FILE_INPUT,
    CONTINUATION_INPUT,
  ]),
  'codex-build': freezeEntries([
    {
      label: 'order id',
      source: 'the orchestrator',
      explanation: 'The label this order is known by. Repeating a call with the same label joins the run already in flight and costs no quota; a different piece of work needs a new label, never a reused one.',
      example: 'plan-13-build-20260804',
    },
    {
      label: 'scope',
      source: 'the orchestrator',
      explanation: 'Comma-separated globs relative to the repository root, listing every file the run may touch — including each caller of what changes, not only the file being edited. Anything outside the list fails the run.',
      example: 'src/home/lib/runner/**,tests/runner/**',
    },
    TASK_FILE_INPUT,
    CONTINUATION_INPUT,
  ]),
  'codex-review': freezeEntries([
    {
      label: 'order id',
      source: 'the orchestrator',
      explanation: 'The label this order is known by. Repeating a call with the same label joins the run already in flight and costs no quota; a different piece of work needs a new label, never a reused one.',
      example: 'plan-13-review-20260804',
    },
    TASK_FILE_INPUT,
    CONTINUATION_INPUT,
  ]),
});

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

export function extractValue(promptText, label) {
  const labelPattern = escapeRegExp(label).replaceAll('\\ ', '\\s+');
  const flag = `--${label.replaceAll(/\s+/g, '-')}`;
  const direct = new RegExp(
    `(?:^|\\r?\\n)\\s*(?:[-*]\\s*)?(?:[*_` + '`' + `]?${labelPattern}[*_` + '`' + `]?)\\s*(?::|=|—|-)\\s*([^\\r\\n]*)`,
    'im',
  );
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
  if (value !== null && !isPlaceholder(value)) {
    if (label === TASK_FILE_INPUT.label && !isAbsoluteTaskFilePath(value)) {
      return { line: readableDiagnosisLine(candidateLine), reason: `value \`${value}\` is not an absolute path` };
    }
    return null;
  }

  const line = readableDiagnosisLine(candidateLine);
  if (value !== null && isPlaceholder(value)) {
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

/** Keeps the 2026-08-05 continuation incident's run and reason in the shared input parser. */
export function parseContinuationGrant(promptText) {
  const prompt = typeof promptText === 'string' ? promptText : '';
  const value = extractValue(prompt, CONTINUATION_INPUT.label);
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
    if (isPlaceholder(value)) return true;
    return entry === TASK_FILE_INPUT && !isAbsoluteTaskFilePath(value);
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
  return `Requires ${entries[0].source}-provided ${rendered}.`;
}

/** Renders the same contract for pass 2 agent instructions. */
export function renderRequiredInputs(agentType) {
  return requiredInputsFor(agentType)
    .map((entry) => {
      const condition = entry.conditional ? ` Condition: ${entry.conditional}.` : '';
      return `- ${entry.label}: ${entry.explanation} Example: \`${entry.example}\`.${condition}`;
    })
    .join('\n');
}
