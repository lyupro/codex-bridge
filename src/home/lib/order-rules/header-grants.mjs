/** Plan_79 D4: owns rules for the grant labels of the task header: continue, retry and advice. */
export const RULES = Object.freeze({
  'grant-label-exclusive': Object.freeze({
    data: Object.freeze([]),
    topic: 'order',
    rule: 'Keep exactly one grant label: continue and retry cannot both appear, even with invalid values.',
    message: () => 'continue and retry cannot both be present; keep exactly one grant label',
  }),
  'advice-value-shape': Object.freeze({
    data: Object.freeze([]),
    topic: 'order',
    rule: 'Give advice a non-empty single-line value in the task header.',
    message: () => 'advice value must be non-empty and single line',
  }),
  'grant-value-shape': Object.freeze({
    data: Object.freeze([]),
    topic: 'order',
    rule: 'Give continue or retry a bare run folder other than . or .. and a non-placeholder reason, ' +
      'separated by an em dash, hyphen or colon.',
    message: () => 'grant must name a bare run folder (not . or ..) and a non-placeholder reason',
  }),
  'continuation-grant-usable': Object.freeze({
    data: Object.freeze(['violation', 'labelName', 'run', 'runsRoot', 'lastRun', 'orderId', 'spent', 'previous', 'example']),
    topic: 'order',
    rule: 'Grant continue to an existing last run of the task chain only when this order has not spent its ' +
      'one continuation and its previous pass has a finished verdict with no running worker; ' +
      'ask the orchestrator for the run and reason, and use a new order id for any further pass.',
    message: ({ violation, labelName, run, runsRoot, lastRun, orderId, spent, previous, example, hints }) => {
      if (violation === 'missing-folder' || violation === 'not-last') {
        const repair = `Example: \`continue: ${example}\`. ` +
          'Action: ask the orchestrator for an explicit grant naming the run and reason; ' +
          'do not invent or reuse a continuation.';
        if (violation === 'missing-folder') {
          return `${labelName} is refused: the orchestrator named run “${run}”, but it does not ` +
            `exist as a run folder in this project's runs directory ${runsRoot}. ` +
            `${hints} ${repair} The submitted grant was not rewritten.`;
        }
        return `${labelName} is refused: grant ${run} is not the LAST run of this task's chain; ` +
          `the current last run is ${lastRun}. A continuation is single-use: continuing the ` +
          'last run appends a later run, so the old grant stops matching by itself — no counter or new ' +
          `state is used. ${hints} ${repair}`;
      }
      if (violation === 'spent') {
        return `${labelName} is refused: order “${orderId}” already spent its allowed continuation on ${spent}. ` +
          `${hints} A further pass needs a new order id from the orchestrator.`;
      }
      if (violation === 'unfinished') {
        return `${labelName} is refused: previous run ${previous} has no finished verdict and may still ` +
          `be editing the worktree. Repeat without ${labelName} to attach to it. ${hints}`;
      }
      throw new Error(`unknown continuation-grant-usable violation: ${violation}`);
    },
  }),
  'retry-grant-usable': Object.freeze({
    data: Object.freeze(['violation', 'run', 'runsRoot', 'previousOrder', 'orderId', 'labelName']),
    topic: 'order',
    rule: 'Grant retry to a bare existing last run of the task chain under its own recorded order id, ' +
      'only after a non-OK finished verdict and after its worker has stopped; retry repeats that pass, ' +
      'while continue grants the next pass.',
    message: ({ violation, run, runsRoot, previousOrder, orderId, labelName }) => {
      if (violation === 'missing-folder') {
        return `Retry is refused: ${run} is not a bare existing run folder in ${runsRoot}.`;
      }
      if (violation === 'not-last') {
        return `Retry is refused: grant ${run} is not the LAST run of this task's chain; a retry is single-use.`;
      }
      if (violation === 'order-mismatch') {
        return `Retry is refused: run ${run} order_id ${previousOrder} differs from order ${orderId}. ` +
          'A retry repeats its own order; a run without order_id predates orders — start a new order.';
      }
      if (violation === 'unfinished') {
        return `Retry is refused: run ${run} has no finished verdict or its worker may still be alive and writing. ` +
          `Repeat without ${labelName} to attach to it.`;
      }
      if (violation === 'ended-ok') {
        return `Retry is refused: run ${run} ended OK. A retry repeats a failed pass; use continue: for the next pass.`;
      }
      throw new Error(`unknown retry-grant-usable violation: ${violation}`);
    },
  }),
  'ready-grant-line': Object.freeze({
    data: Object.freeze(['variant', 'run', 'reason', 'orderId']),
    topic: 'order',
    rule: 'Write a ready continue grant with the latest run and the orchestrator\'s reason, or a retry grant ' +
      'with that failed pass\'s recorded reason and order id; without a run there is no ready grant.',
    message: ({ variant, run, reason, orderId }) => {
      if (variant === 'none') return 'Ready grant line: none (there is no run to continue).';
      if (variant === 'continue') return `Ready grant line: continue: ${run} — ${reason}.`;
      if (variant === 'retry') {
        return `Ready retry line: retry: ${run} — ${reason} (repeats that pass under order ${orderId}).`;
      }
      throw new Error(`unknown ready-grant-line variant: ${variant}`);
    },
  }),
  'grant-last-run-hint': Object.freeze({
    data: Object.freeze(['variant', 'run', 'status', 'reason']),
    topic: 'order',
    rule: 'Use the latest recorded run and its outcome when repairing a continue or retry header grant.',
    message: ({ variant, run, status, reason }) => {
      if (variant === 'none') return 'Last run: none. Outcome: none.';
      if (variant === 'last') return `Last run: ${run}. Outcome: ${status} — ${reason}.`;
      throw new Error(`unknown grant-last-run-hint variant: ${variant}`);
    },
  }),
});
