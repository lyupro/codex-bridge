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
  'sandbox-probe-reason': Object.freeze({
    data: Object.freeze(['variant', 'form', 'status', 'signal']),
    category: 'host-state',
    message: ({ variant, form, status, signal }) => {
      if (variant === 'timeout') return `The ${form} sandbox probe timed out.`;
      if (variant === 'incomplete') return `The ${form} sandbox probe could not start or complete.`;
      if (variant === 'signal') return `The ${form} sandbox probe was terminated by ${signal}.`;
      if (variant === 'arguments') return `Codex rejected the ${form} sandbox probe arguments.`;
      if (variant === 'no-status') return `The ${form} sandbox probe returned no exit status.`;
      if (variant === 'alive') return 'The Codex sandbox started a process.';
      if (variant === 'marker-exit') return `The flagged sandbox probe printed the marker but exited ${status}.`;
      if (variant === 'flags') return 'This version of Codex no longer accepts the package sandbox flags.';
      if (variant === 'unavailable') return 'Codex CLI is unavailable.';
      if (variant === 'dead') return 'The Codex sandbox on this host cannot start a process.';
      throw new Error(`unknown sandbox-probe-reason variant: ${variant}`);
    },
  }),
  'sandbox-refusal-repair': Object.freeze({
    data: Object.freeze([]),
    category: 'host-state',
    message: () => 'Repair the host sandbox; do not rewrite or retry the order.',
  }),
  // Ubuntu 23.10+ forbids unprivileged user namespaces unless an AppArmor profile allows bwrap; that
  // is the ordinary state of a fresh server, not an accident like the corrupted Windows state file.
  'sandbox-linux-repair': Object.freeze({
    data: Object.freeze([]),
    category: 'host-state',
    message: () => [
      'On Ubuntu 23.10 and later this usually means AppArmor does not let bubblewrap create a user namespace.',
      'Official repair: https://learn.chatgpt.com/docs/sandboxing — the bwrap-userns-restrict AppArmor profile',
      '(Ubuntu 24.04) or the bubblewrap package (25.04 and later). Do not set',
      'kernel.apparmor_restrict_unprivileged_userns=0: it lifts the restriction for every program on the host.',
    ].join(' '),
  }),
  'sandbox-operator-check': Object.freeze({
    data: Object.freeze(['command']),
    category: 'host-state',
    message: ({ command }) => `Operator check (run from the repository directory): ${command}`,
  }),
  'sandbox-stderr-evidence': Object.freeze({
    data: Object.freeze(['form', 'stderrTail']),
    category: 'host-state',
    message: ({ form, stderrTail }) =>
      `${form} stderr:\n> ${(stderrTail || '(empty)').replace(/\r\n?/g, '\n').replace(/\n/g, '\n> ')}`,
  }),
  'sandbox-diagnosis-source': Object.freeze({
    data: Object.freeze(['source']),
    category: 'host-state',
    message: ({ source }) => `Sandbox diagnosis source: ${source}`,
  }),
  'sandbox-diagnosis-attribution': Object.freeze({
    data: Object.freeze(['attributed']),
    category: 'host-state',
    message: ({ attributed }) => attributed ? 'Sandbox log lines attributed to this probe:'
      : 'Recent sandbox log lines only; not attributed to this probe:',
  }),
  'sandbox-setup-change': Object.freeze({
    data: Object.freeze(['changed']),
    category: 'host-state',
    message: ({ changed }) =>
      `setup_error.json changed since snapshot: ${changed === null ? 'unknown' : changed ? 'yes' : 'no'}`,
  }),
  'sandbox-evidence-line': Object.freeze({
    data: Object.freeze(['line']),
    category: 'host-state',
    message: ({ line }) => `> ${line}`,
  }),
  'sandbox-evidence-unknown': Object.freeze({
    data: Object.freeze(['variant', 'file']),
    category: 'host-state',
    message: ({ variant, file }) => {
      if (variant === 'unreadable') return `Unknown: unable to read ${file}.`;
      if (variant === 'baseline') return `Unknown: pre-probe size unavailable for ${file}.`;
      throw new Error(`unknown sandbox-evidence-unknown variant: ${variant}`);
    },
  }),
  'sandbox-no-repair': Object.freeze({
    data: Object.freeze([]),
    category: 'host-state',
    message: () => 'No verified repair signature; inspect this log.',
  }),
  'sandbox-known-failure-runtime-file-locked': Object.freeze({
    data: Object.freeze(['part']),
    category: 'host-state',
    message: ({ part }) => {
      if (part === 'summary') {
        return 'A file under the Codex runtimes folder is held open by another process, so sandbox setup cannot update its access rights (openai/codex #51634).';
      }
      if (part === 'repair') {
        return 'Find and close the process holding the file named in the line (on 2026-10-10, the Codex desktop app\'s computer-use helper), then rerun codex-bridge doctor; on Codex CLI 0.162.x the proven workaround is npm install -g @openai/codex@0.160.1.';
      }
      throw new Error(`unknown sandbox-known-failure-runtime-file-locked part: ${part}`);
    },
  }),
  'sandbox-known-failure-deny-read-state-corrupt': Object.freeze({
    data: Object.freeze(['part', 'file']),
    category: 'host-state',
    message: ({ part, file }) => {
      if (part === 'summary') return 'The sandbox state file is empty or corrupt.';
      if (part === 'repair') {
        return `Back up and rename ${file}, then rerun codex-bridge doctor; the helper recreates it.`;
      }
      throw new Error(`unknown sandbox-known-failure-deny-read-state-corrupt part: ${part}`);
    },
  }),
});
