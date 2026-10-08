# records

Find run artifacts through runner receipts and the project inventory without naming or deriving a run-store root.

## Find a run

Use the absolute run-folder path printed in the runner's `RUN=` or `ATTACH=` line. Keep that returned path as the run identity; do not reconstruct it from a timestamp, project name, package installation, home directory or another run.

For earlier runs, use `codex-bridge projects [<project>] --json`. Use the run object's `path` field, which is the absolute run-folder path. If no project is supplied, first find the project in the inventory; do not concatenate names to invent a path.

Render the selected run with `codex-bridge read <run>`, passing the returned run path. This renders its structured event stream. The inventory and receipt are the lookup contract; diagnostics are not a substitute for them.

## Read the artifacts

A started run records its lifecycle and output in its run folder:

- `meta.json`: agent, phase and final status; use it to identify an advisor advise pass before citing it in `advice:`.
- `status.json`: lifecycle state (`running`, `finished`, `failed` or `abandoned`) and runner PID.
- `result.json`: structured scout, build or advisor result; build includes `summary`, `changes`, `verify_command`, `verify_passed`, `leftovers` and `report_markdown`.
- `review.json`: the review agent's structured result instead of `result.json`.
- `report.md`: the full report; the runner expands a build result's `report_markdown` into this file.
- `events.jsonl` and `stderr.log`: transport evidence for progress, deadline or startup failures.

A failed or interrupted run may have no complete result. Read the recorded status and available evidence rather than treating a missing report as an empty successful run.

## Availability verdicts

`LIMIT` means the ChatGPT quota window is exhausted, not a task defect. For a writing run, also check the runner's indication of whether the tree was touched.

`UNAVAILABLE` means Codex is missing or signed out on this host; the task could not run. A pre-start availability refusal may leave no run folder. Neither verdict is a reason to retry the same bridge. Preserve the verdict and any existing artifacts.
