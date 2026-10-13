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
  'codex-unavailable-handoff': Object.freeze({
    data: Object.freeze(['variant', 'signal']),
    category: 'host-state',
    message: ({ variant, signal }) => {
      if (variant === 'handoff') {
        return 'UNAVAILABLE — Codex is not available (signed out); ' +
          'hand the task to the next executor, do not retry';
      }
      if (variant === 'signal') return `Signal: ${signal}`;
      if (variant === 'operator-check') {
        return 'Operator check: codex --version; codex login status (sign in with codex login)';
      }
      throw new Error(`unknown codex-unavailable-handoff variant: ${variant}`);
    },
  }),
  'stale-runs-root-override': Object.freeze({
    data: Object.freeze([]),
    category: 'host-state',
    message: () => 'CODEX_RUNS_ROOT points under a retired runs root; remove it or set it to the new location.',
  }),
  'runs-move-record-invalid': Object.freeze({
    data: Object.freeze(['file', 'violation', 'detail', 'index']),
    category: 'host-state',
    message: ({ file, violation, detail, index }) => {
      let defect;
      if (violation === 'parse') defect = detail;
      else if (violation === 'version') defect = 'version must be 1';
      else if (violation === 'retired-array') defect = 'retired must be a non-empty array';
      else if (violation === 'retired-root') defect = `retired[${index}].root must be an absolute path`;
      else if (violation === 'retired-time') defect = `retired[${index}].movedAt must be a parseable ISO time`;
      else throw new Error(`unknown runs-move-record-invalid violation: ${violation}`);
      return `Invalid runs move record ${file}: ${defect}`;
    },
  }),
});
