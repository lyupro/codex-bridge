/** Defines order-authoring rules and their refusal text once, as required by Plan_79 D3. */

export const ORDER_RULES = Object.freeze({
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
      throw new Error(`unknown scout-questions violation: ${violation}`);
    },
  }),
  'question-context-marker': Object.freeze({
    topic: 'order',
    rule: 'If a question uses a context-only marker, spell it exactly [context-only] and place it ' +
      'only once, at the start, followed by whitespace (such as a space) and non-empty question text.',
    message: ({ index, text }) =>
      `Q${index + 1} has an invalid context-only marker in ${JSON.stringify(text)}`,
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

export function orderRuleMessage(key, values = {}) {
  if (!Object.hasOwn(ORDER_RULES, key)) throw new Error(`unknown order rule: ${key}`);
  return ORDER_RULES[key].message(values);
}

// Plan_79 D3: callers supply the topic catalogue so installed rules do not depend on the CLI tree.
export function validateOrderRules(rules, topics, diagnostics) {
  for (const [key, entry] of Object.entries(rules)) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key)) {
      throw new Error(`invalid order rule key: ${key}`);
    }
    if (Object.hasOwn(diagnostics, key)) throw new Error(`duplicate order key: ${key}`);
    if (!entry || Object.keys(entry).length !== 3 ||
        !['topic', 'rule', 'message'].every((field) => Object.hasOwn(entry, field))) {
      throw new Error(`invalid order rule entry: ${key}`);
    }
    if (!Object.hasOwn(topics, entry.topic)) throw new Error(`unknown order rule topic: ${key}`);
    if (typeof entry.rule !== 'string' || !entry.rule.trim() || entry.rule.includes('{{')) {
      throw new Error(`invalid order rule text: ${key}`);
    }
    if (typeof entry.message !== 'function') throw new Error(`invalid order rule message: ${key}`);
  }
}
