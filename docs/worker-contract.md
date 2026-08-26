# `worker.json` Contract

`worker.json` is the only job that the launcher passes to the detached worker. After startup,
the worker does not reread the CLI or `run-config.json`: this protects the run from argument drift
and from configuration changes in the middle of execution.

## What the launcher writes

The file is created after all task/schema/snapshot artifacts and before the worker starts.

```json
{
  "agent": "codex-build",
  "slug": "auth-flow",
  "order_id": "<job label from the orchestrator>",
  "repo": "<repository root>",
  "is_git_repo": true,
  "launcher_pid": 12345,
  "budget_minutes": 25,
  "scope_new": ["src/runner/scope-check.mjs"],
  "profile": {
    "model": "gpt-5.6-luna",
    "model_source": "config",
    "effort": "max",
    "effort_source": "config"
  },
  "args": ["exec", "--disable", "hooks", "--disable", "plugins"]
}
```

| Field | Written by launcher | Purpose |
| --- | --- | --- |
| `agent` | always | One of `codex-scout`, `codex-build`, `codex-review`. |
| `slug` | always | Task name used to read the directory and link runs into a chain. |
| `order_id` | always | Job label issued by the orchestrator; the chain uses it to find a repeated run that renamed itself. |
| `repo` | always | Normalized root where Codex works and git state is captured. |
| `is_git_repo` | always | Whether build should capture HEAD; also affects `--skip-git-repo-check`. |
| `launcher_pid` | always | Identifier of the first half for later auditing. |
| `budget_minutes` | always | Run time limit in minutes, taken from the configuration's `budgets` for the mode (`scout` 15, `build` 25, `review` 20). When it expires, the worker kills Codex and writes the verdict itself. |
| `scope_new` | always (an empty list if the flag was absent) | Paths from `--scope-new`: files that do not exist at startup and that the run creates. Only for `codex-build`. They are recorded so that months later it remains clear which missing paths were declared intentionally rather than accepted by mistake. |
| `profile` | always | The worker that was ordered: `model` (empty when nothing is pinned and Codex chooses), `model_source` (`config` or `codex default`), `effort`, and `effort_source` (`request`, `config`, or `fallback`). Recorded apart from `args` because an absent `-m` says nothing on its own — a run that was never given the operator's configured model looked exactly like a run for which none was configured, which is how a pinned profile went unnoticed for three releases (2026-08-26). `meta.json` and the dispatcher reply both read it from here. |
| `args` | always | Full argv for the Codex command, including the sandbox, output schema, and result path. |

`args` already contains the decisions about `hooks` and `plugins`, `effort`, directory, schema, and
result file. The worker must not assemble this list again.

## What the worker reads

The current implementation reads five fields:

- `repo` — for post-execution snapshots;
- `agent` — to select build artifacts and the result;
- `args` — to start Codex;
- `is_git_repo` — to decide whether to read HEAD after build;
- `budget_minutes` — the time limit after which Codex is killed together with its entire process
  tree (on Windows this is `taskkill /T /F`: the direct child there is `cmd.exe`, while Codex is
  its child, and `kill` would terminate only the shell).

The worker does not read `slug`, `order_id`, `launcher_pid`, `scope_new`, or `profile`. This is the actual
asymmetric state of the contract, not a documentation error: these fields are retained to make the
directory explainable during later investigation — including making it clear months later which job
owned the run. The chain link and active worker pid come from `status.json`, not `worker.json`.

## Related files

`worker.json` does not contain the task text or schema. The worker reads `task.md` separately, while
the paths to `schema.json`, `result.json`, or `review.json` are already inside `args`. Process state
lives in `status.json`; environment settings live in `env.json`.

## Format change rules

- A field required by the worker must be written before `spawn()`.
- Reading the live `run-config.json` must not be moved into the worker: that would allow a single run
  to receive different settings before and after detachment.
- `slug` or `launcher_pid` must not be removed merely because the worker does not read them: they are
  part of the saved job's audit trail.
- When names or types change, `launcher.mjs`, `worker.mjs`, and a live end-to-end run must be checked
  together: unit tests do not prove transfer between processes.
