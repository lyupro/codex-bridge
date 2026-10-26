/** OW-075: one place for the next-step row of every non-OK outcome;
 * a new outcome adds a variant here, not a bullet in the rules core. */
const NEXT_ACTION_TEXT = Object.freeze({
  'capacity': "Action: wait or change this role's model (/codex-bridge:model), then repeat the same order once with a retry: grant; never resume: this run; a second CAPACITY for the same order goes to the next executor",
  'limit': 'Action: the ChatGPT quota window is spent; do not retry or resume through this bridge, hand the order to the next executor; for a build, check the Worktree row first',
  'unavailable': 'Action: Codex is signed out on this host; do not retry this bridge, hand the order to the next executor and ask the operator to run codex login',
  'fail-result': 'Action: the run returned a result that did not pass; read the report and git status before deciding; a repeat of this pass needs your retry: grant, the next pass your continue: grant',
  'fail-no-result': 'Action: the run left no usable result; read the log and git status before deciding; repeat only through a grant this reply offers or the operator approves, never take over the task yourself',
  'usage': 'Action: nothing was started and no quota was spent; fix the task file or the call as the refusal says, then call again',
  'pending': 'Action: the run is still working and nothing new was started; repeat the same call without --no-wait to wait for its verdict; never start the order again under another id',
  'pending-no-run': 'Action: no run exists for this order and --no-wait never starts one; call again without --no-wait to start it',
  'grant-decision': "Action: nothing was started and no quota was spent; the grant does not fit the run it names: read that run's outcome, then call again with the grant or new order id the refusal names; never change the task to get past it",
  'run-in-progress': 'Action: nothing was started and no quota was spent; another run holds this order or writes in this tree: wait for it (repeating the same order attaches to a run of that order), then call again; never stop it without the operator',
  'runs-root-retired': 'Action: nothing was started and no quota was spent; the runs root setting points at a retired location: show this to the operator to fix CODEX_RUNS_ROOT, then repeat the same order',
  'repository-detached': 'Action: nothing was started and no quota was spent; the repository is not on the branch an abandoned run expects: show this to the operator and repair the branch only with their approval, then repeat the same order',
  'sandbox-dead': 'Action: nothing was started and no quota was spent; the Codex sandbox cannot start on this host: show this output to the operator, do not change the order, and hand it to the next executor if it cannot wait',
  'advisor-scope-result': 'Action: nothing was started and no quota was spent; the scope run named in continue: has no usable result: repeat that scope with retry: or under a new order id, then call advise again',
  'runner-fault': 'Action: the runner failed before the work started; show this output to the operator and hand the order to the next executor; do not repeat it unchanged',
  'readiness-unconfirmed': 'Action: check codex --version for up to about 2 minutes; when it answers, repeat the same order exactly once; otherwise, or on the same refusal again, hand the order to the next executor and name that in the summary',
  'availability-unconfirmed': 'Action: show this output to the operator (codex --version, and codex login if authorization is rejected); do not treat it as signed out and do not change the order',
});

export const NEXT_ACTION_VARIANTS = Object.freeze(Object.keys(NEXT_ACTION_TEXT));

export const DIAGNOSTICS = Object.freeze({
  'next-action': Object.freeze({
    data: Object.freeze(['variant']),
    category: 'next-action',
    message: ({ variant }) => {
      if (typeof variant === 'string' && Object.hasOwn(NEXT_ACTION_TEXT, variant)) {
        return NEXT_ACTION_TEXT[variant];
      }
      throw new Error(`unknown next-action variant: ${variant}`);
    },
  }),
});
