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
  'agent-accepted-labels': Object.freeze({
    data: Object.freeze(['label', 'agent']),
    topic: 'order',
    rule: 'Use only the header labels accepted by the agent assigned to this order.',
    message: ({ label, agent }) => `label "${label}" is not accepted by ${agent}`,
  }),
  'order-value-placeholder': Object.freeze({
    data: Object.freeze(['label']),
    topic: 'order',
    rule: 'Replace placeholder header values with the actual values assigned to this order.',
    message: ({ label }) => `label "${label}" is still a placeholder`,
  }),
  'header-shell-safety': Object.freeze({
    data: Object.freeze(['labelName', 'sequence']),
    topic: 'order',
    rule: 'Keep header values short and free of forbidden shell sequences; put free text in the task file body.',
    message: ({ labelName, sequence }) =>
      `${labelName} contains forbidden shell sequence ${JSON.stringify(sequence)}; ` +
      'put free text in the task file body and keep header values short',
  }),
  'build-existing-scope-required': Object.freeze({
    data: Object.freeze(['labelName', 'newLabelName']),
    topic: 'order',
    rule: 'For codex-build, declare at least one existing path pattern in scope; scope new does not replace it.',
    message: ({ labelName, newLabelName }) =>
      `${labelName} is required for codex-build: declare at least one existing path pattern; ` +
      `${newLabelName} does not replace it.`,
  }),
  'required-order-labels': Object.freeze({
    data: Object.freeze(['label', 'example']),
    topic: 'order',
    rule: 'Include every required header label for the assigned agent, using its example as a guide.',
    message: ({ label, example }) =>
      `missing required header label "${label}:"; example: ${label}: ${example}`,
  }),
  'scope-pattern-shape': Object.freeze({
    data: Object.freeze(['violation', 'part', 'pattern']),
    topic: 'order',
    rule: 'Write scope and scope new as repository-relative file patterns with forward slashes, ' +
      'no line breaks, parent-directory segments or service directories; name a file or use a glob for a directory.',
    message: ({ violation, part, pattern }) => {
      if (part !== 'reason' && part !== 'action') throw new Error(`unknown scope-pattern-shape part: ${part}`);
      if (violation === 'line-break') return part === 'reason'
        ? 'contains a newline or carriage return'
        : 'use a glob instead of a literal path containing a line break';
      if (violation === 'absolute') return part === 'reason'
        ? 'is an absolute or drive-qualified path'
        : 'use a path relative to the repository root with forward slashes';
      if (violation === 'backslash') return part === 'reason'
        ? 'uses backslash separators'
        : 'replace backslashes with forward slashes';
      if (violation === 'parent-directory') return part === 'reason'
        ? 'contains a parent-directory (..) segment'
        : 'remove the .. segment and keep the path relative to the repository root';
      if (violation === 'service-directory') return part === 'reason'
        ? 'lies inside a service directory that no scope can authorise'
        : 'name the file outside the service directory, or make that edit yourself';
      if (violation === 'directory' || violation === 'new-directory') {
        if (part === 'reason') return 'names a directory rather than a file';
        if (violation === 'directory') {
          return `write ${pattern.replace(/\/$/, '')}/** for everything inside it, or name the file itself`;
        }
        return `write ${pattern}/** if it is a directory, or declare the new file by its own name with an extension; a new extensionless file is declared through its directory`;
      }
      throw new Error(`unknown scope-pattern-shape violation: ${violation}`);
    },
  }),
  'scope-pattern-match': Object.freeze({
    data: Object.freeze(['violation', 'part', 'repoRoot', 'labelName', 'message']),
    topic: 'order',
    rule: 'Each ordinary scope pattern must parse and match an existing repository path; ' +
      'start from the git repository root, use UTF-8 file names, and declare intentionally new paths with scope new.',
    message: ({ violation, part, repoRoot, labelName, message }) => {
      if (part !== 'reason' && part !== 'action') throw new Error(`unknown scope-pattern-match part: ${part}`);
      if (violation === 'missing') return part === 'reason'
        ? 'does not match any existing path in the repository'
        : `correct the pattern or declare an intentionally new path with ${labelName}`;
      if (violation === 'not-repository') return part === 'reason'
        ? `does not match any existing path under ${repoRoot}; ` +
          'git could not list that folder as a repository, so it was walked instead'
        : `start the run from the repository root (cd into it, or pass ${labelName} <repository root>); ` +
          'if this folder is the intended one, correct the pattern';
      if (violation === 'invalid-glob') return part === 'reason'
        ? `could not parse the pattern: ${message}`
        : 'correct the pattern and retry';
      if (violation === 'non-utf8') return part === 'reason'
        ? message
        : 'rename the non-UTF-8 file using a UTF-8 file name and retry';
      throw new Error(`unknown scope-pattern-match violation: ${violation}`);
    },
  }),
});
