/** Plan_79 D4: owns rules for the call line and the task file itself. */
export const RULES = Object.freeze({
  'task-file-path': Object.freeze({
    data: Object.freeze(['value']),
    topic: 'order',
    rule: 'The call names the task file by an absolute path to a file the orchestrator wrote with its file tool.',
    message: ({ value }) => `--task-file must be an absolute path; got ${JSON.stringify(value)}`,
  }),
  'task-body-required': Object.freeze({
    data: Object.freeze(['channel', 'taskFile']),
    topic: 'order',
    rule: 'The task file carries a non-empty body after the header and the blank line.',
    message: ({ channel, taskFile }) => {
      if (channel === 'task-file') return `task file from --task-file is empty: ${taskFile}`;
      if (channel === 'stdin') return 'task text on stdin is empty';
      throw new Error(`unknown task-body-required channel: ${channel}`);
    },
  }),
  'writing-run-exclusive': Object.freeze({
    data: Object.freeze(['run', 'activePath', 'identity']),
    topic: 'order',
    rule: 'Wait for the active writing run to finish before starting another writing run in the same working tree.',
    message: ({ run, activePath, identity }) => {
      const identityNote = identity === 'unverified' ? '; process identity could not be confirmed' : '';
      return [
        `run ${run} is already active for this repository; two writing runs in one tree are prohibited${identityNote}`,
        `Active run: ${activePath}`,
      ].join('\n');
    },
  }),
});
