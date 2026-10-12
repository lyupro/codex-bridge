/** Plan_79 D4: owns diagnostics for the host's Codex CLI readiness and availability. */
export const DIAGNOSTICS = Object.freeze({
  'codex-readiness-unconfirmed': Object.freeze({
    data: Object.freeze(['detail']),
    category: 'host-state',
    message: ({ detail }) => [
      `Codex CLI readiness unconfirmed: ${detail}`,
      'Do not skip this bridge: check codex --version for up to about 2 minutes; when it answers, repeat the same order exactly once; if it does not answer, hand the order to the next executor and name that in the summary.',
    ].join('\n'),
  }),
  'codex-unavailable': Object.freeze({
    data: Object.freeze(['detail']),
    category: 'host-state',
    message: ({ detail }) => [
      `Codex CLI unavailable: ${detail}`,
      'Operator check: codex --version (and codex login if authorization is rejected)',
    ].join('\n'),
  }),
  'codex-availability-detail': Object.freeze({
    data: Object.freeze(['variant', 'command', 'status', 'message']),
    category: 'host-state',
    message: ({ variant, command, status, message }) => {
      if (variant === 'path-miss') return 'codex could not be resolved in this process PATH; readiness is unconfirmed';
      if (variant === 'exit-status') return `${command} exited ${status}`;
      if (variant === 'failed') return 'codex availability probe failed';
      if (variant === 'logged-out') return 'codex login status: Not logged in';
      if (variant === 'message') return message;
      throw new Error(`unknown codex-availability-detail variant: ${variant}`);
    },
  }),
});
