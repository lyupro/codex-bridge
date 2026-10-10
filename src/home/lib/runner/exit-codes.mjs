/**
 * Owns every exit code the runner returns.
 * Plan_60 D2a: a new status took code 4, already the released --no-wait outcome, because the codes
 * were literals scattered over six modules.
 */
export const EXIT = Object.freeze({
  OK: 0,          // the run's artifacts confirm the contract
  FAIL: 1,        // the run failed, or a pre-flight refusal: the order was right, the host or tree was not
  USAGE: 2,       // argument error: the order itself must be rewritten
  LIMIT: 3,       // ChatGPT quota exhausted; not a task failure
  PENDING: 4,     // --no-wait only: the run is still in progress, or no run exists (a call outcome, not a status)
  UNAVAILABLE: 5, // Codex signed out (a PATH miss is a free refusal, Plan_78 D5); hand the task to the next executor
});
