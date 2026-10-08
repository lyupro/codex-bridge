# codex-bridge — delegation core

Installed and removed by the `codex-bridge` package; `codex-bridge update` keeps it equal to the package. Change the
package, not this file.

Four dispatcher agents run work on a Codex CLI subscription: `codex-scout` (read-only research), `codex-build`
(writes code inside its `scope`), `codex-review` (second opinion on a diff) and `codex-advisor` (design advice before
code: a `scope` phase, then `advise`).

- The call is one line, `task file: <absolute path>`. Labels go in the task-file header, free text in its body. A
  refused call costs nothing: read the refusal, fix the task file, call again.
- Before writing a task file, run `codex-bridge guidance <topic>` and follow it: `order` (header labels, scope),
  `advisor` (two phases, the `continue:` grant), `budget` (run deadline, slicing), `records` (finding and reading
  runs), `concurrency` (parallel and writing runs). `codex-bridge guidance` lists the topics. If it fails, stop and
  show its output to the operator — never guess the contract.
- Every `codex-build` task file carries exactly one `advice:` line.
- A writing run has a hard deadline: slice the task before the launch, not after a failure. After a deadline `FAIL`,
  look at `git status` before deciding anything.
- One writing run per working tree; read-only runs may go alongside it.
- `LIMIT` means the ChatGPT quota window is spent, `UNAVAILABLE` means Codex is not usable on this host. Neither is a
  task error: do not retry the same bridge.
- `OK — scope: insufficient` from `codex-advisor` is a success: it names the paths the `advise` phase needs.
- Stop a live run with `codex-bridge stop <run>` before `TaskStop`; `TaskStop` alone leaves the run writing.
- A run's folder is the `ATTACH=` path in the dispatcher's reply. Earlier runs: `codex-bridge projects [<project>]
  --json`; render one with `codex-bridge read <run>`. Never derive the run root from where the package is installed.
