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
  'repository-detached-after-abandoned-run': Object.freeze({
    data: Object.freeze(['run', 'branch']),
    category: 'run-state',
    message: ({ run, branch }) =>
      `repository is detached after abandoned run ${run}, which recorded branch ${branch}. ` +
      `Return with: git checkout ${branch}. No run folder was created and no quota was spent.`,
  }),
  'codex-not-started': Object.freeze({
    data: Object.freeze([]),
    category: 'run-state',
    message: () => 'Codex was not started; quota was not spent',
  }),
});
