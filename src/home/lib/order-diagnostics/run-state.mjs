/** Plan_79 D4: owns diagnostics for the run's state at refusal. */
export const DIAGNOSTICS = Object.freeze({
  'run-not-created': Object.freeze({
    data: Object.freeze([]),
    category: 'run-state',
    message: () => 'The run folder was not created; quota was not spent.',
  }),
});
