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
  "phase": "default",
  "budget_minutes": 25,
  "silence_policy": {
    "version": 1,
    "role": "build",
    "phase": "default",
    "threshold_ms": null,
    "calibration": null
  },
  "recovery_policy": {
    "version": 1,
    "role": "build",
    "phase": "default",
    "budget_ms": null,
    "enabled": false,
    "calibration": null,
    "brake": {
      "key": "CODEX_BRIDGE_AUTO_RECOVERY",
      "value": "on",
      "source": "default"
    },
    "watchdog": {
      "version": 1,
      "arming": "off",
      "reason": "no-threshold",
      "armed_switch": false
    }
  },
  "scope_new": ["src/runner/scope-check.mjs"],
  "profile": {
    "model": "gpt-5.6-luna",
    "model_source": "config",
    "effort": "max",
    "effort_source": "config"
  },
  "resume": null,
  "args": ["exec", "--disable", "hooks", "--disable", "plugins"]
}
```

| Field | Written by launcher | Purpose |
| --- | --- | --- |
| `agent` | always | One of `codex-scout`, `codex-build`, `codex-review`, `codex-advisor`. |
| `slug` | always | Task name used to read the directory and link runs into a chain. |
| `order_id` | always | Job label issued by the orchestrator; the chain uses it to find a repeated run that renamed itself. |
| `repo` | always | Normalized root where Codex works and git state is captured. |
| `is_git_repo` | always | Whether build should capture HEAD; also affects `--skip-git-repo-check`. |
| `launcher_pid` | always | Identifier of the first half for later auditing. |
| `phase` | always | The resolved run phase. It travels with the job so the recorded run and its verdict retain the phase the launcher selected. |
| `budget_minutes` | always | Run time limit in minutes, resolved once from the configured budget map by `(role, phase)` and frozen into this order. `budgets.mjs` normalizes the role's phase map; the worker uses this value and never rereads the config. When it expires, the worker kills Codex and writes the verdict itself. |
| `silence_policy` | always | Versioned policy and calibration evidence resolved from the package-owned agent registry before spawn (Plan_80 S2/E12). Copied verbatim into `meta.json`; the worker reads `threshold_ms` for the silence watchdog, without changing verdict or reply logic. A `null` threshold means not calibrated. See [artifact formats](artifact-formats.md#silence-policy). |
| `recovery_policy` | always | Recovery policy resolved by the launcher before worker spawn (Plan_80 E15/O2a): `version`, `role`, `phase`, `budget_ms` (positive milliseconds or `null` when uncalibrated), `enabled` (the package switch), `calibration` (evidence record or `null`), `brake` (`key`, `value`, `source`), and `watchdog` (below). Copied verbatim into `meta.json`; the worker reads `watchdog.arming` for the silence watchdog, without changing verdict or reply logic. |
| `scope_new` | always (an empty list if the flag was absent) | Paths from `--scope-new`: files that do not exist at startup and that the run creates. Only for `codex-build`. They are recorded so that months later it remains clear which missing paths were declared intentionally rather than accepted by mistake. |
| `profile` | always | The worker that was ordered: `model` (empty when nothing is pinned and Codex chooses), `model_source` (`config` or `codex default`), `effort`, and `effort_source` (`request`, `config`, or `fallback`). Recorded apart from `args` because an absent `-m` says nothing on its own — a run that was never given the operator's configured model looked exactly like a run for which none was configured, which is how a pinned profile went unnoticed for three releases (2026-08-26). `meta.json` and the dispatcher reply both read it from here. |
| `args` | always | Full argv for the Codex command, including the sandbox, output schema, and result path. |
| `resume` | always | `null` for a fresh run. For a resume run, `{ "thread_id": "<UUID>", "resumed_from": "<failed run folder>", "sandbox_mode": "read-only" }` freezes the thread id, the run folder it continues, and the literal sandbox mode carried by `args`. Only `codex-scout`, `codex-review`, and `codex-advisor` can resume. The worker does not read it; `meta.json` will. |

`args` already contains the decisions about `hooks` and `plugins`, `effort`, directory, schema, and
result file. The worker must not assemble this list again.

The launcher resolves `recovery_policy.brake` once per run, before any paid work. Its key is
`CODEX_BRIDGE_AUTO_RECOVERY`: an unset or trimmed-empty value records `value: "on"` and
`source: "default"`; exact lowercase `on` or `off` after trimming records that value and
`source: "env"`. Any other value refuses the launch before a run folder exists. The brake can
only switch automatic recovery off; `on` cannot enable a false package switch. The worker
never reads this environment variable. The calibrated advisor `advise` policy records
`budget_ms: 1102000`, `enabled: false`, and calibration id `plan80-s4-2026-10-15`. Its evidence
includes `id`, `measured_on`, `window`, `codex_version`, `sample_runs`, `measure`, `max_tail_ms`,
`margin`, and `rule`.

Plan_80 E16 freezes `recovery_policy.watchdog` before worker spawn using the same
`silence_policy` object carried by the order. Its shape is
`{ version: 1, arming, reason, armed_switch }`, where `armed_switch` is the boolean
package switch for `<role>.<phase>` (absent keys mean `false`), even when `arming` is `off`.
The switch is separate from automatic recovery's `enabled`; neither can enable the other.

| Arming | Reason | Meaning |
| --- | --- | --- |
| `off` | `no-threshold` | `silence_policy.threshold_ms` is `null`; this takes precedence over the brake. |
| `off` | `host-brake` | A threshold exists, but `brake.value` is `off`; the brake disables the watchdog even if its package switch is true. |
| `shadow` | `package-switch-off` | A threshold exists, the brake is on, and the package switch is false. The detector records a confirmed stall without stopping Codex. |
| `armed` | `package-switch` | A threshold exists, the brake is on, and the package switch is true. A confirmed stall requests a stop. |

The shipped `advisor.advise` switch is `false`: the live detector is unproven and
the calibrated threshold leaves only 141 s over the longest healthy pause.
The worker passes the detector to `runCodex`; it confirms a stall with a second session-log read and makes
at most one decision per run. The frozen arming never starts a continuation.

## What the worker reads

The current implementation reads the following fields:

- `repo` — for post-execution snapshots;
- `agent` — to select build artifacts and the result;
- `args` — to start Codex;
- `silence_policy.threshold_ms` — the frozen silence threshold (`null` for older orders);
- `recovery_policy.watchdog.arming` — the frozen `off`, `shadow`, or `armed` state (`off` for older orders);
- `is_git_repo` — to decide whether to read HEAD after build;
- `budget_minutes` — the time limit after which Codex is killed together with its entire process
  tree (on Windows this is `taskkill /T /F`: the direct child there is `cmd.exe`, while Codex is
  its child, and `kill` would terminate only the shell).

`phase` is carried in the saved order for phase-aware accounting and verdicts. The worker does not
consult `config.json` to reinterpret the phase or recalculate its budget.

The worker does not read `slug`, `order_id`, `launcher_pid`, `scope_new`, `profile`, or `resume`. This is the actual
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
