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

export const REQUIRED_INPUTS = Object.freeze({
  'codex-scout': freezeEntries([
    {
      label: 'order id',
      source: 'the orchestrator',
      explanation: 'The label this order is known by. Repeating a call with the same label joins the run already in flight and costs no quota; a different piece of work needs a new label, never a reused one.',
      example: 'plan-13-scout-20260804',
    },
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
      example: 'src/runner/**,tests/runner/**',
    },
    CONTINUATION_INPUT,
  ]),
  'codex-review': freezeEntries([
    {
      label: 'order id',
      source: 'the orchestrator',
      explanation: 'The label this order is known by. Repeating a call with the same label joins the run already in flight and costs no quota; a different piece of work needs a new label, never a reused one.',
      example: 'plan-13-review-20260804',
    },
    CONTINUATION_INPUT,
  ]),
});

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function cleanValue(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^([`'\"])(.*)\1$/, '$2').trim();
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
  return requiredInputsFor(agentType).filter(
    (entry) => !entry.conditional && isPlaceholder(extractValue(prompt, entry.label)),
  );
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
