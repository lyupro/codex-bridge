/** Plan_79 D4: owns diagnostics for filesystem access. */
export const DIAGNOSTICS = Object.freeze({
  'task-file-readable': Object.freeze({
    data: Object.freeze(['message']),
    category: 'filesystem',
    message: ({ message }) => `task file from --task-file could not be read: ${message}`,
  }),
  'project-runs-folder-required': Object.freeze({
    data: Object.freeze(['projectRunsRoot']),
    category: 'filesystem',
    message: ({ projectRunsRoot }) => `project runs folder does not exist: ${projectRunsRoot}`,
  }),
});
