# `status.json` and `meta.json` Formats

Both files are updated by fully rewriting the JSON. `status.json` shows the lifecycle;
`meta.json` records the final verdict and accounting. On normal completion, `meta.json` is written
before the final update to `status.json`.

## `status.json`

### Startup fields

| Field | Value |
| --- | --- |
| `state` | Initially `running`. Later `finished`, `failed`, `aborted_pre_start`, or `abandoned`. |
| `pid` | The process whose death means that the current stage was abandoned: initially the launcher, after spawn the worker. |
| `process_started_at` | Start time of the process that owns `pid`, in ISO 8601. The launcher writes `null` when handing over to the worker pid; the worker replaces this value with its actual start time. |
| `launcher_pid` | Launcher pid; not replaced after the worker detaches. |
| `runner_pid` | Worker pid; added after a successful spawn. |
| `agent` | Name of the selected dispatcher. |
| `slug` | Normalized task slug. |
| `task_hash` | Fingerprint of the normalized task text; the chain uses it to find a repeated run whose name was changed. |
| `order_id` | Job label from the orchestrator; the chain uses it to find a repeated run whose name and text were both changed. |
| `repo` | Repository root. |
| `started_at` | Run creation time in ISO 8601. |
| `continues` | Optional name of the first directory in the chain if the run was started with continuation. |
| `continued_from` | Optional name of the run named by the `continue:` authorization in the task text. Unlike `continues`, this is not the start of the chain, but the run after which the orchestrator instructed execution to continue. An investigation trace; enforcement is handled by the “named run is the last in the chain” rule. |

### Completion fields

| Field | Value |
| --- | --- |
| `stopped_on_deadline` | Whether the runner killed the run at its time limit. Written by the worker immediately after Codex returns, before the verdict; `false` means “the runner monitored the run and did not kill it.” An absent field means a run from the previous contract. This fact used to live in a log line, where Codex itself also writes. |
| `elapsed_ms` | How long the run lived before Codex returned. This is actual elapsed time, not the allocated budget: the budget is in `worker.json#budget_minutes`. |
| `stdio_drained` | Whether the worker managed to wait for stdout/stderr to close normally. `true` means a normal `close`; `false` means closure after a limited grace period because a stream held the process open. The field is written before the verdict and does not replace `stopped_on_deadline`. |
| `status` | Final `OK`, `FAIL`, or `LIMIT`; appears when closing with a verdict. |
| `finished_at` | Time of the final verdict in ISO 8601. |
| `tree_after` | For `abandoned`, written as `false`: the post-run tree snapshot is unknown. |
| `abandoned_reason` | Reason why a dead, unclosed process was declared abandoned. |
| `abandoned_at` | Time of that decision. |

A normal `collect()` completes a run as `state=finished` even when the verdict is `FAIL` or `LIMIT`:
the worker reached result computation normally. `state=failed` is used for an infrastructure-level
`writeFailure()`, such as a runner crash. `state=abandoned` means that no verdict exists.

`state=aborted_pre_start` is a refusal **before** Codex starts: a busy tree, unavailable CLI, an
argument that cannot pass through `cmd.exe`, or failure to spawn the worker. No Codex session existed
and no quota was spent, so such a directory does not count as a completed task pass: the chain sees it
in the audit, but the `--continue` gate and baseline tree snapshot skip it. Before pre-start aborts had
their own state, these refusals were recorded as `failed`, just like a run that had worked for twenty
minutes, and the next attempt for the same job required continuation authorization despite an empty
directory. Directories from the previous contract are recognized through `meta.json`: `exit: null`,
`session_id: null`, zero `events_bytes` and `stderr_bytes`, and `tokens_reported: false`. The numeric
values in `meta.json`, rather than the presence of `events.jsonl`, are authoritative because age-based
cleanup deletes transport files, which would otherwise make a paid run look as though it never started.

## The `heartbeat` file

`heartbeat` is a regular file in the run directory that the worker updates when data arrives from Codex
and periodically during execution. Its modification time is used by `hooks/live-runs.mjs` to detect silence:
a heartbeat no older than five minutes is considered fresh. Its content is a diagnostic timestamp, not
a verdict source.

A missing `heartbeat` means an old run from before heartbeats were introduced: its live pid keeps the
lock so the new logic does not unexpectedly open the tree. A stale heartbeat with a live pid indicates
a possibly hung process, but does not allow `unlock` to close the record: a confirmed live run remains
`running`, and `unverified` remains with an explanation. This requires
`codex-bridge stop <run>`, which kills the process first.

## `meta.json`

### Fields of a normal `collect()`

| Field | Value |
| --- | --- |
| `agent` | Agent name. |
| `runner_version` | Version of the runner package whose code wrote `meta.json`; taken directly from its `package.json`, not from launch arguments. An absent field means a historical run created before the runner: it does not violate the contract and is not evaluated under the runner sandbox rules. |
| `project` | Repository directory name used as the run grouping level. |
| `run` | Directory name of this run. |
| `finished_at` | Time when meta was computed, in ISO 8601. |
| `exit` | Numeric Codex code; `null` if none exists. |
| `status` | `OK`, `FAIL`, or `LIMIT`. |
| `reason` | Reason for `FAIL`/`LIMIT`; `null` for a normal `OK`. |
| `carried_from_earlier_run` | `true` if the claimed work is found in the chain's accumulated diff but not in the current run's delta. Always present in a normal collect. |
| `environment_changes` | Paths changed between snapshots that matched `env.json.environmentPaths`. They are visible in the audit but excluded from work evaluation. |
| `result_ok` | The result was read as JSON and contains the agent's primary required content field. |
| `events_bytes` | Size of `events.jsonl` in bytes. |
| `stderr_bytes` | Size of `stderr.log` in bytes. Normally it is **not** zero: a live probe on 2026-08-05 found hundreds of bytes of execpolicy refusals there for a completely healthy run. |
| `usage` | The `usage` object from `turn.completed`, exactly as sent by the CLI, with all numeric values; for multiple turns they are summed. |
| `tokens` | `input_tokens + output_tokens` from events; `null` if no turn reported usage. |
| `tokens_reported` | Whether a token count was recognized. `false` does not mean zero usage. |
| `model` | Value of the `model:` line from the log, or `null`. |
| `sandbox` | Value of the `sandbox:` line from the log, or `null`. |
| `env` | Contents of `env.json`; may be `null` for an old or early run. |
| `session_id` | Value of the `session id:` line from the log, or `null`. |

### Early `writeFailure()`

A failure before normal `collect()` also creates `meta.json`, but its shape is narrower. It writes
`agent`, `project`, `run`, `finished_at`, `exit: null`, `status: "FAIL"`, `reason`,
`result_ok: false`, `events_bytes`, `stderr_bytes`, `tokens: null`, `tokens_reported: false`,
`model: null`, `sandbox: null`, `session_id: null`, and the available `env`.

This branch has no `carried_from_earlier_run` or `environment_changes`: the required snapshots and
result might not yet have existed. Consumers must distinguish an absent field from `false` or an
empty list.

## File relationships

- `status.json` answers “is the process running, and how did it end?”
- `meta.json` answers “why was this verdict reached, and what supports it?”
- `events.jsonl` is the CLI event stream under `--json`, the only source for the `LIMIT` verdict, usage,
  and session identifier; `stderr.log` is what the CLI says outside the protocol, including execpolicy
  refusals from a live run. A person reads a run with `codex-bridge read <run>`, which renders events
  on demand.
- The indication that a run was required to leave events is the `--json` flag in its own
  `worker.json#args`. A run with the flag but without `events.jsonl` is corrupt, not archival, and is
  judged as `FAIL`; the same applies to a `stopped_on_deadline` field without `stderr.log`. See `verdict.md`.
- `raw.log` in runs before 0.2.0 contained both streams interleaved. New runs do not write it:
  under `--json` it duplicated `events.jsonl`, and a verdict cannot depend on a file that
  `/codex-bridge:usage` itself declares removable.
- `reply.txt` is only a brief representation of meta; it is not a source of truth.
- Recomputing an old run takes `environmentPaths` from its `env.json`, not from the current
  `config.json`.
