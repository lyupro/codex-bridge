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
      if (variant === 'grant-decision') return "Action: nothing was started and no quota was spent; the grant does not fit the run it names: read that run's outcome, then call again with the grant or new order id the refusal names; never change the task to get past it";
      if (variant === 'run-in-progress') return 'Action: nothing was started and no quota was spent; another run holds this order or writes in this tree: wait for it (repeating the same order attaches to a run of that order), then call again; never stop it without the operator';
      if (variant === 'runs-root-retired') return 'Action: nothing was started and no quota was spent; the runs root setting points at a retired location: show this to the operator to fix CODEX_RUNS_ROOT, then repeat the same order';
      if (variant === 'repository-detached') return 'Action: nothing was started and no quota was spent; the repository is not on the branch an abandoned run expects: show this to the operator and repair the branch only with their approval, then repeat the same order';
      if (variant === 'sandbox-dead') return 'Action: nothing was started and no quota was spent; the Codex sandbox cannot start on this host: show this output to the operator, do not change the order, and hand it to the next executor if it cannot wait';
      if (variant === 'advisor-scope-result') return 'Action: nothing was started and no quota was spent; the scope run named in continue: has no usable result: repeat that scope with retry: or under a new order id, then call advise again';
      if (variant === 'runner-fault') return 'Action: the runner failed before the work started; show this output to the operator and hand the order to the next executor; do not repeat it unchanged';
      if (variant === 'readiness-unconfirmed') return 'Action: check codex --version for up to about 2 minutes; when it answers, repeat the same order exactly once; otherwise, or on the same refusal again, hand the order to the next executor and name that in the summary';
      if (variant === 'availability-unconfirmed') return 'Action: show this output to the operator (codex --version, and codex login if authorization is rejected); do not treat it as signed out and do not change the order';
      throw new Error(`unknown next-action variant: ${variant}`);
    },
  }),
});
