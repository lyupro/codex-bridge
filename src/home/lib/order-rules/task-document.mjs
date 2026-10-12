/** Plan_79 D4: owns rules for task-body sections. */
export const RULES = Object.freeze({
  'scout-questions': Object.freeze({
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
});
