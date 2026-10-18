/** Plan_79 D4: owns rules for the grant labels of the task header: continue, retry and advice. */
export const RULES = Object.freeze({
  'grant-label-exclusive': Object.freeze({
    data: Object.freeze([]),
    topic: 'order',
    rule: 'Keep exactly one grant label: continue, retry and resume cannot appear together, even with invalid values.',
    message: () => 'continue, retry and resume are mutually exclusive; keep exactly one grant label',
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
    rule: 'Give continue, retry or resume a bare run folder other than . or .. and a non-placeholder reason, ' +
      'separated by an em dash, hyphen or colon.',
    message: () => 'grant must name a bare run folder (not . or ..) and a non-placeholder reason',
  }),
  'continuation-grant-usable': Object.freeze({
    data: Object.freeze(['violation', 'labelName', 'run', 'runsRoot', 'lastRun', 'orderId', 'spent', 'previous', 'example', 'successor']),
    topic: 'order',
    rule: 'Grant continue to an existing last run of the task chain only when this order has not spent its ' +
      'one continuation and its previous pass has a finished verdict with no running worker; ' +
      'ask the orchestrator for the run and reason, and use a new order id for any further pass.',
    message: ({ violation, labelName, run, runsRoot, lastRun, orderId, spent, previous, example, hints, successor }) => {
      if (violation === 'missing-folder' || violation === 'not-last') {
        const repair = `Example: \`continue: ${example}\`. ` +
          'Action: ask the orchestrator for an explicit grant naming the run and reason; ' +
          'do not invent or reuse a continuation.';
        if (violation === 'missing-folder') {
          return `${labelName} is refused: the orchestrator named run “${run}”, but it does not ` +
            `exist as a run folder in this project's runs directory ${runsRoot}. ` +
            `${hints} ${repair} The submitted grant was not rewritten.`;
        }
        if (typeof successor === 'string' && successor.length > 0) {
          return `${labelName} is refused: run ${run} was already continued automatically in ${successor}, ` +
            `which is now the LAST run of this task's chain; name ${successor} in the grant instead. ` +
            `${hints} ${repair}`;
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
    data: Object.freeze(['violation', 'run', 'runsRoot', 'previousOrder', 'orderId', 'labelName', 'successor']),
    topic: 'order',
    rule: 'Grant retry to a bare existing last run of the task chain under its own recorded order id, ' +
      'only after a non-OK finished verdict and after its worker has stopped; retry repeats that pass, ' +
      'while continue grants the next pass.',
    message: ({ violation, run, runsRoot, previousOrder, orderId, labelName, successor }) => {
      if (violation === 'missing-folder') {
        return `Retry is refused: ${run} is not a bare existing run folder in ${runsRoot}.`;
      }
      if (violation === 'not-last') {
        if (typeof successor === 'string' && successor.length > 0) {
          return `Retry is refused: run ${run} was already continued automatically in ${successor}, ` +
            `which is now the LAST run of this task's chain; name ${successor} in the grant instead.`;
        }
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
      if (variant === 'resume') {
        return `Ready resume line: resume: ${run} — ${reason} (continues that pass's Codex thread under order ${orderId}).`;
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
  'advisor-scope-continuation': Object.freeze({
    data: Object.freeze(['phaseLabel', 'continueLabel']),
    topic: 'order',
    rule: 'Never continue an advisor scope pass; repeat failed scope with retry, or use a new order id without continue.',
    message: ({ phaseLabel, continueLabel }) =>
      `codex-advisor ${phaseLabel} scope refuses ${continueLabel}: a scope pass is never continued, and continuing one ` +
      "spends the order's single continuation that its advise phase needs. Action: repeat the scope under a new order id " +
      `without ${continueLabel} and without a continue: grant, then run advise as that order's continuation; a ` +
      'scope run that failed is repeated with a `retry:` grant instead.',
  }),
  'retry-pass-identity': Object.freeze({
    data: Object.freeze(['agent', 'phase']),
    topic: 'order',
    rule: 'Retry the named run with its own agent and phase.',
    message: ({ agent, phase }) => `a retry repeats the named run's own agent and phase: ${agent}/${phase}.`,
  }),
  'resume-grant-usable': Object.freeze({
    data: Object.freeze(['violation', 'run', 'runsRoot', 'previousOrder', 'orderId', 'labelName',
      'blockers', 'state', 'reason', 'recordedAt', 'currentAt', 'reasons', 'successor']),
    topic: 'order',
    rule: 'Grant resume only to the last run of the task chain under its own order id, after a finished non-OK ' +
      'verdict with its worker stopped, when the run is eligible by its recorded stop facts and its Codex thread ' +
      'has not advanced since it stopped; resume continues that pass\'s thread, retry repeats it on a fresh ' +
      'thread, continue grants the next pass.',
    message: ({ violation, run, runsRoot, previousOrder, orderId, labelName, blockers, state, reason,
      recordedAt, currentAt, reasons, successor }) => {
      if (violation === 'missing-folder') {
        return `Resume is refused: ${run} is not a bare existing run folder in ${runsRoot}.`;
      }
      if (violation === 'not-last') {
        if (typeof successor === 'string' && successor.length > 0) {
          return `Resume is refused: run ${run} was already continued automatically in ${successor}, ` +
            `which is now the LAST run of this task's chain; name ${successor} in the grant instead.`;
        }
        return `Resume is refused: grant ${run} is not the LAST run of this task's chain; a resume is single-use.`;
      }
      if (violation === 'order-mismatch') {
        return `Resume is refused: run ${run} order_id ${previousOrder} differs from order ${orderId}. ` +
          'A resume continues its own order; a run without order_id predates orders — start a new order.';
      }
      if (violation === 'unfinished') {
        return `Resume is refused: run ${run} has no finished verdict or its worker may still be alive and writing. ` +
          `Repeat without ${labelName} to attach to it.`;
      }
      if (violation === 'ended-ok') {
        return `Resume is refused: run ${run} ended OK. A resume continues a failed pass's Codex thread; ` +
          'use continue: for the next pass.';
      }
      if (violation === 'not-eligible') {
        return `Resume is refused: run ${run} cannot be resumed: ${blockers.join(', ')}. ` +
          'A retry: grant repeats it on a fresh thread.';
      }
      if (violation === 'inputs-unusable') {
        return `Resume is refused: run ${run} cannot be replayed: ${reasons.join(', ')}. ` +
          'A retry: grant repeats it on a fresh thread.';
      }
      if (violation === 'thread-unreadable') {
        return `Resume is refused: run ${run} Codex thread is ${state}; reason: ${reason}.`;
      }
      if (violation === 'thread-time-unknown') {
        return `Resume is refused: run ${run} Codex thread last record time is unknown: ` +
          `recorded last_record_at ${recordedAt}; current last_record_at ${currentAt}.`;
      }
      if (violation === 'thread-advanced-after-stop') {
        return `Resume is refused: run ${run} Codex thread advanced after stop: ` +
          `recorded last_record_at ${recordedAt}; current last_record_at ${currentAt}.`;
      }
      throw new Error(`unknown resume-grant-usable violation: ${violation}`);
    },
  }),
  'resume-pass-identity': Object.freeze({
    data: Object.freeze(['agent', 'phase']),
    topic: 'order',
    rule: 'Resume the named run with its own agent and phase.',
    message: ({ agent, phase }) => `a resume continues the named run's own agent and phase: ${agent}/${phase}.`,
  }),
  'repeat-task-grant-required': Object.freeze({
    data: Object.freeze(['violation', 'continueLabel', 'slugLabel', 'slug', 'count', 'latest']),
    topic: 'order',
    rule: 'Ask the orchestrator for a continue grant before repeating an existing task, even under a different slug.',
    message: ({ violation, continueLabel, slugLabel, slug, count, latest, hints }) => {
      let previous;
      if (violation === 'renamed') previous = `this task already ran in this repository under the name “${slug}”`;
      else if (violation === 'existing') previous = `runs for task “${slug}” already exist in this repository`;
      else throw new Error(`unknown repeat-task-grant-required violation: ${violation}`);
      return `${continueLabel} is required: ${previous} (${count}), latest: ${latest}. ` +
        'A repeat run is allowed, but the orchestrator decides, not the runner: it read the ' +
        `previous response and knows whether work remains. Add ${continueLabel} if you are finishing ` +
        `the same task; changing ${slugLabel} with the same task text does not stop it being a repeat. ${hints}`;
    },
  }),
  'advisor-advise-continuation': Object.freeze({
    data: Object.freeze(['phaseLabel', 'continueLabel']),
    topic: 'order',
    rule: 'Grant advise as the continuation of the scope run of the same order so it can settle the predicted risks.',
    message: ({ phaseLabel, continueLabel }) =>
      `codex-advisor ${phaseLabel} advise requires a ${continueLabel} grant naming the scope run: phase 2 continues the scope run of the same order ` +
      'so it can settle the risks phase 1 predicted.',
  }),
  'build-advice-required': Object.freeze({
    data: Object.freeze([]),
    topic: 'order',
    rule: 'Start a build order with advice naming an OK advisor advise run, or mechanical, revert, docs-only or test-only work without design choices.',
    message: () => 'codex-build requires the task file to start with the header line `advice: <value>`, where the ' +
      'value is mechanical | revert | docs-only | test-only ' +
      'or an absolute path to an existing advisor run directory whose meta.json says agent codex-advisor, ' +
      'phase advise, status OK. ' +
      'An order that invents a construction needs a second opinion first; only work with no design choice may skip it.',
  }),
  'advise-scope-run-required': Object.freeze({
    data: Object.freeze(['violation']),
    topic: 'order',
    rule: 'Name an OK codex-advisor scope run in the continue grant for advise.',
    message: ({ violation, failed }) => {
      if (violation === 'agent') return "agent must be 'codex-advisor'";
      if (violation === 'phase') return "phase must be 'scope'";
      if (violation === 'status') return "status must be 'OK'";
      if (violation === 'meta') return `continued run meta.json failed ${failed}.`;
      throw new Error(`unknown advise-scope-run-required violation: ${violation}`);
    },
  }),
  'advice-retired-root': Object.freeze({
    data: Object.freeze(['candidate', 'retiredRoot', 'destination', 'equivalent']),
    topic: 'order',
    rule: 'When advice points under a retired runs root, update advice to the equivalent path ' +
      'under the current destination or pass that path explicitly; retired paths are never silently remapped.',
    message: ({ retiredRoot, destination, equivalent }) =>
      `Run records moved from ${retiredRoot} to ${destination}. Equivalent path: ${equivalent}. ` +
      'Update advice: or pass this new path explicitly. No path was remapped.',
  }),
});
