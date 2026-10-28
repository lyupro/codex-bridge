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
- `task.md`: the task the runner assembled for the executor, not a byte copy of the orchestrator's task file.
- `result.json`: structured scout, build or advisor result; build includes `summary`, `changes`, `verify_command`, `verify_passed`, `leftovers` and `report_markdown`.
- `review.json`: the review agent's structured result instead of `result.json`. {{review-required-fields}}.
- `report.md`: the full report; the runner expands a build result's `report_markdown` into this file.
- `events.jsonl` and `stderr.log`: transport evidence for progress, deadline or startup failures.
- `raw.log`: transport evidence when present; retention may remove it.

A failed or interrupted run may have no complete result. Read the recorded status and available evidence rather than treating a missing report as an empty successful run.

## Resumed runs

A resumed pass gets its own new run folder. Its `status.json` records `resumed_from` naming the parent run. A granted resume saves the task body as `resume-note.md` in the new run folder; the resumed run never reads that note and reuses the named run's frozen task and inputs. Cite and read the newest run of the chain, not the parent.

## Availability verdicts

Every non-OK reply and every refusal carries one `Action:` row with the next step; it neither grants recovery nor overrides a grant line.

`LIMIT` means the ChatGPT quota window is exhausted, not a task defect. For a writing run, also check the runner's indication of whether the tree was touched.

`UNAVAILABLE` means Codex is signed out on this host; the task could not run. A pre-start availability refusal may leave no run folder. Neither verdict is a reason to retry the same bridge. Preserve the verdict and any existing artifacts.

`CAPACITY` (exit 6) means the role's model is overloaded right now, not a task error: wait or change the role's model (`/codex-bridge:model`), then repeat the order once with `retry:`; never `resume:` it. A second `CAPACITY` of the same order goes to the next executor. The reply has no ready grant line on purpose; the runner refuses `resume:` of a CAPACITY run and refuses a second consecutive capacity retry as `capacity-repeated`. Preserve the verdict and artifacts.

A `FAIL` whose Action names the output limit means the order was too large for one answer: narrow it and use `retry:` with the revised task; never `resume:` it, which sent OW-078's resumed pass into the same ceiling.

A refusal starting `Codex CLI readiness unconfirmed:` is not `UNAVAILABLE`: it leaves no run folder and costs no quota. Do not skip the bridge; follow its `Action:` row — check `codex --version` for up to ~2 minutes. When it answers, repeat the same order exactly once; if it does not, hand the order to the next executor and name that in the summary. If the repeat gets the same refusal, hand the order to the next executor as well; no second repeat.
