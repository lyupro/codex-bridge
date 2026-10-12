/** Plan_79 D4: owns diagnostics for the command-line flags the dispatcher passes to the runner. */
export const DIAGNOSTICS = Object.freeze({
  'no-wait-grant-conflict': Object.freeze({
    category: 'cli-flags',
    message: ({ grant }) =>
      `--no-wait cannot be combined with a ${grant} grant: ` +
      'checking an existing run must never authorize a new one.',
  }),
});
