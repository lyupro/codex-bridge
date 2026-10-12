/** Plan_79 D4: owns diagnostics for the run's state at refusal. */
export const DIAGNOSTICS = Object.freeze({
  'run-not-created': Object.freeze({
    data: Object.freeze([]),
    category: 'run-state',
    message: () => 'The run folder was not created; quota was not spent.',
  }),
  'advise-scope-result-readable': Object.freeze({
    data: Object.freeze(['scopeFile', 'message']),
    category: 'run-state',
    message: ({ scopeFile, message }) => `Cannot read advise scope result at ${scopeFile}: ${message}`,
  }),
  'advise-scope-result-shape': Object.freeze({
    data: Object.freeze(['scopeFile']),
    category: 'run-state',
    message: ({ scopeFile }) =>
      `Malformed advise scope result at ${scopeFile}: expected predicted_risks and missing_paths arrays.`,
  }),
});
