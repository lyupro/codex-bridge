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
  'advise-scope-input-required': Object.freeze({
    data: Object.freeze([]),
    category: 'internal',
    message: () => 'Cannot carry advise scope result: runsRoot and grantRun are required.',
  }),
  'order-claim-input-valid': Object.freeze({
    data: Object.freeze(['violation']),
    category: 'internal',
    message: ({ violation }) => {
      if (violation === 'order-id') return 'orderId must be a non-empty string';
      if (violation === 'role') return 'role must be launcher or worker';
      throw new Error(`unknown order-claim-input-valid violation: ${violation}`);
    },
  }),
  'advisor-task-text-required': Object.freeze({
    data: Object.freeze([]),
    category: 'internal',
    message: () => 'Advisor task text must be a string.',
  }),
  'sandbox-probe-repository-required': Object.freeze({
    data: Object.freeze([]),
    category: 'internal',
    message: () => 'sandbox probe requires a repository path',
  }),
  'dispatcher-agent-input-known': Object.freeze({
    data: Object.freeze(['agentType']),
    category: 'internal',
    message: ({ agentType }) => `unknown dispatcher agent ${JSON.stringify(agentType)}`,
  }),
  'dispatcher-prompt-text-required': Object.freeze({
    data: Object.freeze([]),
    category: 'internal',
    message: () => 'prompt text is missing or is not text',
  }),
  'dispatcher-refusal': Object.freeze({
    data: Object.freeze([]),
    category: 'internal',
    message: ({ reason }) => `Refused: ${reason}.`,
  }),
});
