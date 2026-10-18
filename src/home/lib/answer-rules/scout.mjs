/** OW-068 / Plan_80 E21: scout answer policy shared by prompt statements and exact rejection reasons. */

// How much prose an answer must carry once coordinates and paths are subtracted. Measured
// on the scout run of 2026-07-30 that replied with a table of `file.ts:60-79` rows: every
// one of its six sub-answers scored under 30, while the shortest honest explanation of a
// single mechanism in the same report scored above 120. 80 is one full sentence; 200 is
// the single-question mode, where one question means the whole answer is the essay.
export const MIN_SUBSTANCE_CHARS = 80;
export const MIN_SINGLE_SUBSTANCE_CHARS = 200;

const DEFAULT = Object.freeze(['default']);

export const RULES = Object.freeze({
  'scout-answer-every-question': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'Provide a separate, non-empty answer for every ordered sub-question, identified by its question_id.',
    message: ({ count, questions }) => `scout did not answer ${count} sub-questions: ${questions}`,
    data: Object.freeze(['count', 'questions']),
  }),
  'scout-answer-substance': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: `For every ordered sub-question, write an analysis with at least ${MIN_SUBSTANCE_CHARS} substantive characters: count letters and digits only, after removing code coordinates (file.ext:12, file.ext:12-40), anything containing a slash or backslash, backticks, punctuation and whitespace.`,
    message: ({ questions }) => `response to ${questions} contains coordinates without analysis`,
    data: Object.freeze(['questions']),
  }),
  'scout-answer-evidence': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'For every ordered sub-question, include at least one non-empty reference in its evidence array.',
    message: ({ questions }) => `responses without a single code reference: ${questions}`,
    data: Object.freeze(['questions']),
  }),
  'scout-single-answer-substance': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: `When the order has no separate sub-questions, write the top-level answer with at least ${MIN_SINGLE_SUBSTANCE_CHARS} substantive characters: count letters and digits only, after removing code coordinates (file.ext:12, file.ext:12-40), anything containing a slash or backslash, backticks, punctuation and whitespace.`,
    message: ({ chars }) => `response without analysis: ${chars} substantive characters, minimum ${MIN_SINGLE_SUBSTANCE_CHARS} (coordinates and paths excluded)`,
    data: Object.freeze(['chars']),
  }),
  'scout-startup-reference': Object.freeze({
    phases: DEFAULT,
    when: 'startup-context',
    rule: 'For every question about handed startup context, include an evidence item starting with startup: followed by non-whitespace text naming the source.',
    message: ({ questions }) => `responses to startup-context questions without a startup:<source> reference: ${questions}`,
    data: Object.freeze(['questions']),
  }),
  'scout-unread-coordinate': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'When no command has been executed, do not cite repository code coordinates in answer evidence or finding locations; references to handed startup context are exempt.',
    message: ({ coordinate }) => `scout cited ${coordinate} without executing a command: an address nobody read`,
    data: Object.freeze(['coordinate']),
  }),
  'scout-commands-run': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'Base answers on commands run against the repository, except when every question asks about handed startup context.',
    message: () => 'scout executed no command, so no answer rests on reading the code; check stderr.log for sandbox refusals before changing the order',
    data: Object.freeze([]),
  }),
});
