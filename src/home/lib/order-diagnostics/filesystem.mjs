/** Plan_79 D4: owns diagnostics for filesystem access. */
export const DIAGNOSTICS = Object.freeze({
  'task-file-readable': Object.freeze({
    category: 'filesystem',
    message: ({ message }) => `task file from --task-file could not be read: ${message}`,
  }),
});
