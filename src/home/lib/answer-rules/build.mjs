/** OW-068 / Plan_80 E21: build answer policy pairs prompt instructions with exact existing judge reasons. */

// Reserved for verdicts where the work really was the wrong work, not for check artefacts.
export const WRONG_WORK = 'wrong work was done: ';

const DEFAULT = Object.freeze(['default']);
const show = (files) => files.slice(0, 3).join(', ');

export const RULES = Object.freeze({
  'build-commit': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'Do not make a commit or otherwise change HEAD during the run; leave the work uncommitted for the orchestrator.',
    message: ({ before, after }) => `commit made despite prohibition: ${before.slice(0, 12)} → ${after.slice(0, 12)}`,
    data: Object.freeze(['before', 'after']),
  }),
  'build-branch-detached': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'Do not detach HEAD during the run; keep the repository on its starting branch.',
    message: ({ before }) => `branch moved despite prohibition: ${before} → detached HEAD`,
    data: Object.freeze(['before']),
  }),
  'build-branch-moved': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'Do not create a new branch or switch branches during the run; keep the starting branch, or the starting detached HEAD, unchanged.',
    message: ({ before, after }) => `branch moved despite prohibition: ${before || 'detached HEAD'} → ${after}`,
    data: Object.freeze(['before', 'after']),
  }),
  'build-verify-failed': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'Run the required verification and report its command and actual result: verify_passed: false fails the run and leaves the changes in the tree.',
    message: ({ command }) => `verification “${command}” failed; changes remain in the tree`,
    data: Object.freeze(['command']),
  }),
  'build-outcome-fail': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'Declare outcome "fail" when the requested work was not carried out and explain why in summary; outcome "fail" fails the run even if verification passes.',
    message: ({ summary }) => `the task was not done: ${summary || 'build declared fail and gave no summary'}`,
    data: Object.freeze(['summary']),
  }),
  'build-outcome-missing': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'When the response contract requires outcome, fill it with "done" or "fail"; a missing, null or empty outcome fails the run.',
    message: () => 'result is not filled in: the response contract requires outcome "done" or "fail"',
    data: Object.freeze([]),
  }),
  'build-outcome-unknown': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'Use exactly "done" or "fail" for outcome when required by the response contract; other values, including different case or surrounding whitespace, fail the run.',
    message: ({ value }) => `result declares an unknown outcome “${value}”, expected "done" or "fail"`,
    data: Object.freeze(['value']),
  }),
  'build-out-of-scope': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'Every changed file must match the order\'s scope; changing an out-of-scope file fails the run even if the requested work was also done.',
    message: ({ files }) => `out-of-scope changes (${files.length}): ${show(files)}`,
    data: Object.freeze(['files']),
  }),
  'build-report-names-nothing': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'When this run changes task files, name them in the report\'s changes[]; a report naming no changes fails when task files changed.',
    message: ({ touched }) => `${WRONG_WORK}tree changed (${touched.length}: ${show(touched)}), but the report names no changes`,
    data: Object.freeze(['touched']),
  }),
  'build-report-service-directories': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'The report\'s changes[] must name task files, never a path inside a service directory such as .git/ or .claude/; earlier runs do not excuse service-directory work.',
    message: ({ service }) => `${WRONG_WORK}report describes work in service directories (${show(service)}), not task files`,
    data: Object.freeze(['service']),
  }),
  'build-report-mismatch': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'The report\'s changes[] must name files the run actually changed, or files changed by earlier runs of this same task; a report matching neither fails.',
    message: ({ declared, touched }) => `${WRONG_WORK}report names ${show(declared)}, but ${show(touched)} changed`,
    data: Object.freeze(['declared', 'touched']),
  }),
  'build-report-no-change': Object.freeze({
    phases: DEFAULT,
    when: 'always',
    rule: 'If this run changed no task files, leave changes[] empty unless the declared files were changed by earlier runs of this same task.',
    message: () => 'run did not change the tree, and earlier runs of this task do not contain the declared files',
    data: Object.freeze([]),
  }),
});
