/** Plan_79 D4: owns diagnostics for the command-line flags the dispatcher passes to the runner. */
export const DIAGNOSTICS = Object.freeze({
  'no-wait-grant-conflict': Object.freeze({
    category: 'cli-flags',
    message: ({ grant }) =>
      `--no-wait cannot be combined with a ${grant} grant: ` +
      'checking an existing run must never authorize a new one.',
  }),
  'task-channel-conflict': Object.freeze({
    category: 'cli-flags',
    message: () => 'task text was supplied through both stdin and --task-file; choose exactly one channel',
  }),
  'unexpected-argument': Object.freeze({
    category: 'cli-flags',
    message: ({ value }) => `unexpected argument: ${value}`,
  }),
  'unknown-flag': Object.freeze({
    category: 'cli-flags',
    message: ({ name, help }) =>
      `unknown flag --${name}: codex-bridge run takes only --agent, --task-file and --no-wait; ` +
      'the order belongs in the task-file header' + (help ? `\n${help}` : ''),
  }),
  'boolean-flag-value': Object.freeze({
    category: 'cli-flags',
    message: ({ name, value }) =>
      `--${name} takes no value, or one of 1/true/yes/0/false/no; got ${JSON.stringify(value)}. ` +
      'A placeholder left in from the prompt template is not consent.',
  }),
  'missing-flag-value': Object.freeze({
    category: 'cli-flags',
    message: ({ key }) => `missing value for ${key}`,
  }),
  'flag-shell-safety': Object.freeze({
    category: 'cli-flags',
    message: ({ name, sequence }) =>
      `--${name} contains forbidden shell sequence ${JSON.stringify(sequence)}; ` +
      'put free text in the task file and pass only a short command-line value.',
  }),
  'agent-required': Object.freeze({
    category: 'cli-flags',
    message: () => '--agent is required',
  }),
  'agent-known': Object.freeze({
    category: 'cli-flags',
    message: ({ agent }) => `unknown --agent ${agent}`,
  }),
});
