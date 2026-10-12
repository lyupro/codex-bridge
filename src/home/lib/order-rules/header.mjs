/** Plan_79 D4: owns rules for values and placement of task-header labels. */
export const RULES = Object.freeze({
  'order-header-label-shape': Object.freeze({
    data: Object.freeze(['label', 'violation']),
    topic: 'order',
    rule: 'Write header labels at column one with their exact spelling and a non-empty value.',
    message: ({ label, violation }) => {
      if (violation === 'empty') return `header label "${label}" has an empty value`;
      if (violation === 'spelling') return `write the header label exactly as "${label}:"`;
      throw new Error(`unknown order-header-label-shape violation: ${violation}`);
    },
  }),
  'unknown-header-label': Object.freeze({
    data: Object.freeze(['label', 'knownLabels']),
    topic: 'order',
    rule: 'Use only known header labels; an unknown lowercase label after a header line is refused.',
    message: ({ label, knownLabels }) =>
      `unknown header label "${label}"; known labels: ${knownLabels.join(', ')}`,
  }),
  'duplicate-order-label': Object.freeze({
    data: Object.freeze(['label']),
    topic: 'order',
    rule: 'Write each header label at most once, even when the repeated values are identical.',
    message: ({ label }) => `duplicate ${label} label`,
  }),
  'grant-label-exclusive': Object.freeze({
    data: Object.freeze([]),
    topic: 'order',
    rule: 'Keep exactly one grant label: continue and retry cannot both appear, even with invalid values.',
    message: () => 'continue and retry cannot both be present; keep exactly one grant label',
  }),
  'advice-value-shape': Object.freeze({
    data: Object.freeze([]),
    topic: 'order',
    rule: 'Give advice a non-empty single-line value in the task header.',
    message: () => 'advice value must be non-empty and single line',
  }),
  'grant-value-shape': Object.freeze({
    data: Object.freeze([]),
    topic: 'order',
    rule: 'Give continue or retry a bare run folder other than . or .. and a non-placeholder reason, ' +
      'separated by an em dash, hyphen or colon.',
    message: () => 'grant must name a bare run folder (not . or ..) and a non-placeholder reason',
  }),
  'header-metadata-placement': Object.freeze({
    data: Object.freeze(['label', 'violation']),
    topic: 'order',
    rule: 'Put grants and advice only in the header at the top of the task file, with a non-empty value; ' +
      'quote examples with > or reword them inside a sentence, including examples in code fences.',
    message: ({ label, violation }) => {
      const repairHint = `move it into the header at the top of the file, spelled ${label}: <value>; ` +
        'if it is an example, quote it with > or reword it inside a sentence';
      if (violation === 'misplaced') return `misplaced ${label} metadata; ${repairHint}`;
      if (violation === 'empty') return `${label} value must be non-empty and single line; ${repairHint}`;
      throw new Error(`unknown header-metadata-placement violation: ${violation}`);
    },
  }),
  'effort-value': Object.freeze({
    data: Object.freeze(['value']),
    topic: 'order',
    rule: 'When effort is present, use a non-empty single word with no whitespace.',
    message: ({ value }) =>
      `must be a non-empty single word with no whitespace; got ${JSON.stringify(value)}`,
  }),
  'run-slug': Object.freeze({
    data: Object.freeze(['value']),
    topic: 'order',
    rule: 'The slug, or order id when slug is absent or empty, must contain a letter or digit ' +
      'after replacing characters outside A-Z, a-z, 0-9, dot, underscore and hyphen with hyphens.',
    message: ({ value }) =>
      `produces an unusable run folder name after sanitization: ${JSON.stringify(value)} must contain a letter or digit.`,
  }),
  'repository-path': Object.freeze({
    data: Object.freeze(['violation', 'value', 'segment', 'context', 'label']),
    topic: 'order',
    rule: 'When repository is present, use an absolute path to an existing directory; ' +
      'no path segment other than . or .. may end in a dot or a space, which Windows strips.',
    message: ({ violation, value, segment, context, label, reason }) => {
      if (context === 'task-input') {
        return `${label} ${reason}\nThe run folder was not created; quota was not spent.`;
      }
      if (context !== undefined) throw new Error(`unknown repository-path context: ${context}`);
      if (violation === 'relative') {
        return `must be an absolute path to the repository; got ${JSON.stringify(value)}.`;
      }
      if (violation === 'altered-segment') {
        return `has a path segment ending in a dot or a space (${JSON.stringify(segment)}), which Windows strips; ` +
          `got ${JSON.stringify(value)}.`;
      }
      if (violation === 'not-directory') {
        return `must name an existing directory; ${JSON.stringify(value)} is not one.`;
      }
      throw new Error(`unknown repository-path violation: ${violation}`);
    },
  }),
});
