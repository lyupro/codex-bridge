# codex-bridge — delegation core

Installed, updated and removed by the `codex-bridge` package: change the package, not this file.

Four dispatcher agents run work on a Codex CLI subscription: `codex-scout` (read-only research), `codex-build`
(writes code inside its `scope`), `codex-review` (second opinion on a diff) and `codex-advisor` (design advice before
code: a `scope` phase, then `advise`).

- The call is one line, `task file: <absolute path>`. Labels go in the task-file header, free text in its body.
  Pre-start refusals spend no quota.
- Before every task file, run `codex-bridge guidance order` and follow it: it lists the enforced rules.
  Other topics, via `codex-bridge guidance <topic>`: `advisor` (two phases, the `continue:` grant),
  `budget` (run deadline, slicing), `records` (finding and reading runs), `concurrency` (parallel and writing
  runs); `codex-bridge guidance` lists them. If it fails, stop and show its output to the operator — never guess
  the contract.
- Every `codex-build` task file carries exactly one `advice:` line.
- A writing run has a hard deadline: slice the task before the launch, not after a failure. After a deadline `FAIL`,
  look at `git status` before deciding anything.
- One writing run per working tree; read-only runs may go alongside it.
- For every non-OK call outcome, including pre-start refusals, follow the runner's single `Action:` row for the
  next step and retry/resume/handoff limits. If it is missing or conflicts with other instructions, stop and show
  the output to the operator; never guess or take over the task.
- Dispatchers forward runner output verbatim. Only the orchestrator grants recovery.
- Grant meanings only: `retry:` repeats on a fresh thread; `resume:` continues its own Codex thread.
- `OK — scope: insufficient` from `codex-advisor` is a success: it names the paths the `advise` phase needs.
- Stop a live run with `codex-bridge stop <run>` before `TaskStop`; `TaskStop` alone leaves the run writing.
- A run's folder is the `ATTACH=` path in the dispatcher's reply. Earlier runs: `codex-bridge projects [<project>]
  --json`; render one with `codex-bridge read <run>`. Never derive the run root from where the package is installed.
