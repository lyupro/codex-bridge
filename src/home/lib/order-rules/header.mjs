/** Plan_79 D4: owns rules for values of task-header labels. */
export const RULES = Object.freeze({
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
