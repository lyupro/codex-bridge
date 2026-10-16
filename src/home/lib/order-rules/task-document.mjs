/** Plan_79 D4: owns rules for task-body sections. */
export const RULES = Object.freeze({
  'resume-task-body': Object.freeze({
    data: Object.freeze(['heading']),
    topic: 'order',
    rule: 'Under a resume grant, write the task body as a plain note: the resumed run reuses the ' +
      'frozen questions, options, paths and verification of the named run and never reads this body, ' +
      'so Questions, Options, Paths and Verify headings are refused.',
    message: ({ heading }) => '`resume:` task body has a "' + heading.slice(0, 60) +
      '" section: a resumed run reuses the frozen inputs of the named run and never reads this body; ' +
      'remove the section and keep a plain note (to change the task, use retry: or a new order id); no quota was spent.',
  }),
  'scout-questions': Object.freeze({
    data: Object.freeze(['violation', 'line']),
    topic: 'order',
    rule: 'For codex-scout, include a non-empty Questions section in the task document. ' +
      'Whenever Questions is present, put each question on its own line as a Markdown list item ' +
      'using -, *, or a number followed by a dot.',
    message: ({ violation, line }) => {
      if (violation === 'non-list-line') {
        return `Questions section contains a non-list line: ${JSON.stringify(line.trim())}`;
      }
      if (violation === 'empty') return 'Questions section is empty';
      if (violation === 'missing') {
        return 'a sub-question is required for codex-scout: put one Markdown list item per sub-question ' +
          'under a `Questions` heading in the task document. ' +
          'The runner will not infer questions from the task text; no quota was spent.';
      }
      throw new Error(`unknown scout-questions violation: ${violation}`);
    },
  }),
  'question-context-marker': Object.freeze({
    data: Object.freeze(['index', 'text', 'context']),
    topic: 'order',
    rule: 'If a question uses a context-only marker, spell it exactly [context-only] and place it ' +
      'only once, at the start, followed by whitespace (such as a space) and non-empty question text.',
    message: ({ index, text, context, refusal }) => {
      if (context === 'task-input') {
        return `${refusal}; the marker is exactly [context-only] followed by a space and the question; no quota was spent.`;
      }
      if (context !== undefined) throw new Error(`unknown question-context-marker context: ${context}`);
      return `Q${index + 1} has an invalid context-only marker in ${JSON.stringify(text)}`;
    },
  }),
  'verify-line': Object.freeze({
    data: Object.freeze(['violation']),
    topic: 'order',
    rule: 'When a Verify section is present, put exactly one non-empty command line in it; ' +
      'blank lines are ignored. The section runs until the next heading of the same or a higher level, ' +
      'so any non-empty line after the command, including a paragraph or a second command, counts as another line. ' +
      'Put ## Verify last or follow it with another heading.',
    message: ({ violation }) => {
      if (violation === 'empty') return 'Verify section is empty';
      if (violation === 'multiple-lines') return 'Verify section must contain exactly one non-empty line';
      throw new Error(`unknown verify-line violation: ${violation}`);
    },
  }),
  'advisor-task-options': Object.freeze({
    data: Object.freeze(['violation', 'lineNo', 'line', 'preference', 'optionId']),
    topic: 'order',
    rule: 'For an advisor task, write a ## Options section with at least two distinct options ' +
      'as - option-id: description, using ids matching [a-z0-9][a-z0-9-]*; ' +
      'remove preference markers from every line in that section (Plan_59 D5).',
    message: ({ violation, lineNo, line, preference, optionId }) => {
      if (violation === 'missing') return 'Options: add a "## Options" section with at least two options.';
      const location = `Options line ${lineNo} ${JSON.stringify(line)}`;
      if (violation === 'preference') {
        return `${location}: remove preference marker ${JSON.stringify(preference)} (D5).`;
      }
      if (violation === 'option-shape') {
        return `${location}: use "- option-id: description" with id matching [a-z0-9][a-z0-9-]*.`;
      }
      if (violation === 'duplicate') return `${location}: replace duplicate option id "${optionId}".`;
      if (violation === 'too-few') return `${location}: provide at least two distinct options.`;
      throw new Error(`unknown advisor-task-options violation: ${violation}`);
    },
  }),
  'advisor-task-paths': Object.freeze({
    data: Object.freeze(['violation', 'lineNo', 'line']),
    topic: 'order',
    rule: 'For an advisor task, write a ## Paths section with at least one repository-relative path as a list item.',
    message: ({ violation, lineNo, line }) => {
      if (violation === 'missing') return 'Paths: add a "## Paths" section with repository-relative paths.';
      if (violation === 'empty') {
        return `Paths line ${lineNo} ${JSON.stringify(line)}: add at least one repository-relative path as a list item.`;
      }
      throw new Error(`unknown advisor-task-paths violation: ${violation}`);
    },
  }),
});
