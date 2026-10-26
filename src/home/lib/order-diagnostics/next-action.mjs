/** OW-075: one place for the next-step row of every non-OK outcome;
 * a new outcome adds a variant here, not a bullet in the rules core. */
export const DIAGNOSTICS = Object.freeze({
  'next-action': Object.freeze({
    data: Object.freeze(['variant']),
    category: 'next-action',
    message: ({ variant }) => {
      if (variant === 'capacity') return "Action: wait or change this role's model (/codex-bridge:model), then repeat the same order once with a retry: grant; never resume: this run; a second CAPACITY for the same order goes to the next executor";
      if (variant === 'limit') return 'Action: the ChatGPT quota window is spent; do not retry or resume through this bridge, hand the order to the next executor; for a build, check the Worktree row first';
      if (variant === 'unavailable') return 'Action: Codex is signed out on this host; do not retry this bridge, hand the order to the next executor and ask the operator to run codex login';
      if (variant === 'fail-result') return 'Action: the run returned a result that did not pass; read the report and git status before deciding; a repeat of this pass needs your retry: grant, the next pass your continue: grant';
      if (variant === 'fail-no-result') return 'Action: the run left no usable result; read the log and git status before deciding; repeat only through a grant this reply offers or the operator approves, never take over the task yourself';
      if (variant === 'usage') return 'Action: nothing was started and no quota was spent; fix the task file or the call as the refusal says, then call again';
      if (variant === 'readiness-unconfirmed') return 'Action: check codex --version for up to about 2 minutes; when it answers, repeat the same order exactly once; otherwise, or on the same refusal again, hand the order to the next executor and name that in the summary';
      if (variant === 'availability-unconfirmed') return 'Action: show this output to the operator (codex --version, and codex login if authorization is rejected); do not treat it as signed out and do not change the order';
      throw new Error(`unknown next-action variant: ${variant}`);
    },
  }),
});
