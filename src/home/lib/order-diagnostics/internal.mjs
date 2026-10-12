/** Plan_79 D4: owns diagnostics for internal order contracts. */
export const DIAGNOSTICS = Object.freeze({
  'dispatcher-agent-known': Object.freeze({
    data: Object.freeze(['agent']),
    category: 'internal',
    message: ({ agent }) => `unknown dispatcher agent "${agent}"`,
  }),
  'order-input-name-known': Object.freeze({
    data: Object.freeze(['label']),
    category: 'internal',
    message: ({ label }) => `Unknown order input label "${label}"`,
  }),
});
