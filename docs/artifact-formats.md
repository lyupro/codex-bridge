# `status.json` and `meta.json` Formats

Both files are published through `writeRunJsonAtomic` (`src/home/lib/atomic-json.mjs`): JSON is serialized first,
written to an exclusively created temporary beside the target, flushed (`fsync`) and closed, then renamed over
the target. Readers never see a torn record on any platform: after a crash or power loss they see either the
previous version or the new one. Linux and macOS also flush the parent folder after rename; Windows skips this
step because Node cannot flush folders there, so a power loss may roll the last write back to the previous version.
Readers repair a `running` status with a dead pid to `finished` when `meta.json` records a verdict, or `abandoned`
without `meta.json`. A leftover `*.tmp` is a writer killed before rename; it is never read and is safe to delete.

A rename refused with `EPERM` or `EBUSY` is attempted up to five times, with 20, 40, 80 and 160 ms pauses.
If all attempts fail, the write fails with that error and the previous record stays untouched: the target is
never deleted or written in place, and failure cleanup removes only the writer's own temporary.
`tests/meta/run-record-writers.test.mjs` guards against any other way of writing these two records.

`status.json` shows the lifecycle; `meta.json` records the final verdict and accounting. On normal completion,
`meta.json` is written before the final update to `status.json`.

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
| `phase` | Resolved phase for this run. A single-phase role uses `default`; roles with named phases record the selected phase. |
| `advice` | Build only: the single accepted `advice:` value from the task header. Absent for other agents. |
| `slug` | Normalized task slug. |
| `task_hash` | Fingerprint of the header-free task body, with whitespace and case normalized; the chain uses it to find a repeated run whose name was changed. |
| `task_hash_scheme` | `2` for the header-free task-body fingerprint. An absent field identifies a run that used an earlier hash scheme. |
| `order_id` | Job label from the orchestrator; the chain uses it to find a repeated run whose name and text were both changed. |
| `repo` | Repository root. |
| `started_at` | Run creation time in ISO 8601. |
| `continues` | Optional name of the first directory in the chain if the run was started with continuation. |
| `sandbox_probe` | The launcher's check of the host Codex sandbox, written whole: `outcome` (`alive`, `inconclusive` or `skipped`), `reason`, and `attempts` — one entry per probe form with `form` (`flagged`, `control`, `version`), `status`, `marker`, `ms` and `stderrTail` (at most 300 characters, evidence only, never judged). `dead` never appears here: a dead sandbox refuses before the folder exists. Every launch that reaches the run folder carries it, a busy-tree refusal included; an absent field means a run from before 0.6.3. `inconclusive` adds the row `Sandbox probe: inconclusive — <reason> The run started without a sandbox check.` to the run's reply, whatever the verdict, including a runner failure closed by `writeFailure()`. |
| `continued_from` | Optional name of the run named by the `continue:` grant in the task header. Unlike `continues`, this is not the start of the chain, but the run after which the orchestrator instructed execution to continue. Grant enforcement is handled by the “named run is the last in the chain” rule; this field is the key by which a repeated identical continuation command attaches to the run it already started. For an advisor `advise` phase, the target must also be an `OK` advisor `scope` run. |
| `retry_of` | Optional name of the failed run named by the `retry:` grant in the task header. The retry repeats that pass with the same order id, agent, and phase; it does not count as another continuation. This field lets a repeated identical retry command attach to the run it already started. An advisor `advise` retry carries the original `OK` scope. |
| `resumed_from` | Optional name of the failed run named by the `resume:` grant. The new run continues that pass's Codex thread. When this is a non-empty bare folder name, its reply includes `Attempt: resume of <resumed_from> — continues that pass's Codex thread`; empty or non-bare values add no resume row. Retry rows retain their existing format. |

### Completion fields

| Field | Value |
| --- | --- |
| `stopped_on_deadline` | Whether the runner killed the run at its time limit. Written by the worker immediately after Codex returns, before the verdict; `false` means “the runner monitored the run and did not kill it.” An absent field means a run from the previous contract. This fact used to live in a log line, where Codex itself also writes. |
| `elapsed_ms` | How long the run lived before Codex returned. This is actual elapsed time, not the allocated budget: the budget is in `worker.json#budget_minutes`. |
| `stdio_drained` | Whether the worker managed to wait for stdout/stderr to close normally. `true` means a normal `close`; `false` means closure after a limited grace period because a stream held the process open. The field is written before the verdict and does not replace `stopped_on_deadline`. |
| `stop` | Runner-owned versioned observation of the first stop trigger, stdout receipts and result-file availability; see “Stop record” below. Written after `runCodex`, before the verdict. Absent on older runs. |
| `status` | Final `OK`, `FAIL`, `LIMIT`, `UNAVAILABLE`, or `CAPACITY`; appears when closing with a verdict. |
| `finished_at` | Time of the final verdict in ISO 8601. |
| `tree_after` | For `abandoned`, written as `false`: the post-run tree snapshot is unknown. |
| `abandoned_reason` | Reason why a dead, unclosed process was declared abandoned. |
| `abandoned_at` | Time of that decision. |

Records written by 0.6.17–0.6.18 may carry `stopped_by_silence: false`, which nothing reads.

A normal `collect()` completes a run as `state=finished` even when the verdict is `FAIL`, `LIMIT`, `UNAVAILABLE`, or `CAPACITY`:
the worker reached result computation normally. `state=failed` is used for an infrastructure-level
`writeFailure()`, such as a runner crash. `state=abandoned` means that no verdict exists.

`state=aborted_pre_start` is a refusal **before** Codex starts and **after** the run is registered:
an argument that cannot pass through `cmd.exe`, or failure to spawn the worker. A busy tree and an
unavailable CLI used to be here too; since Plan_58 they refuse before the folder exists and produce no
artifacts at all. No Codex session existed
and no quota was spent, so such a directory does not count as a completed task pass: the chain sees it
in the audit, but the header-grant gate and baseline tree snapshot skip it. Before pre-start aborts had
their own state, these refusals were recorded as `failed`, just like a run that had worked for twenty
minutes, and the next attempt for the same job required continuation authorization despite an empty
directory. Directories from the previous contract are recognized through `meta.json`: `exit: null`,
`session_id: null`, zero `events_bytes` and `stderr_bytes`, and `tokens_reported: false`. The numeric
values in `meta.json`, rather than the presence of `events.jsonl`, are authoritative because age-based
cleanup deletes transport files, which would otherwise make a paid run look as though it never started.
Plan_80 E18 adds a third pre-start branch: an `abandoned` automatic attempt-2 child whose
`resumed_from` matches its marker's bare parent name, with no `events.jsonl` (even empty) or
`heartbeat` and readable `meta.json` containing the same zero-evidence fields; retention removes
transport files but never `meta.json` or `heartbeat`.
`recovery-successor.mjs` is the only reader of the parent-to-child `recovery` relationship,
validating the pointer, child marker and copied identity without writing artifacts.

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

`stop` copies `status.json#stop` verbatim. It is `null` when that field is absent on an older
run: the stop was not observed, rather than observed as false. `collect()` never recomputes
this record or reads additional evidence for it, so collecting again preserves the same `stop`.

### Fields of a normal `collect()`

| Field | Value |
| --- | --- |
| `agent` | Agent name. |
| `phase` | Resolved phase copied from `worker.json` (or `status.json` if needed); `null` for runs made before phases existed. |
| `silence_policy` | Policy frozen in `worker.json#silence_policy`, copied verbatim without consulting today's registry. A `null` object means an older run without this record; a `null` threshold inside an object means not calibrated. Diagnostic only in this release; replies use the stored assessments below, never this policy directly. See below. |
| `recovery_policy` | Policy frozen in `worker.json#recovery_policy`, copied verbatim without consulting today's registry or environment; `null` for an older run without this record. Diagnostic only in this release. See “Recovery policy” below. |
| `situation` | Version-1 classification of the frozen stop evidence; see “Stop assessments” below. |
| `continuation_eligibility` | Version-3 automatic/grant assessments with ordered blockers and grant `policy_version: 1`. Automatic eligibility requires a `silent-stall-candidate` and no blockers; this assessment starts no continuation. |
| `treatment` | Version-1 diagnostic action: `{ version: 1, effect: 'diagnostic-only', action }`. It never executes recovery. |
| `sufficient` | Advisor only: the boolean from the advisor result, or `null` when the result did not say. An insufficient scope can still be a valid `OK` result. |
| `missing_paths` | Advisor only: paths the result identified as needed, or `null` when the result did not say. |
| `advice` | Build only: copied from `status.json#advice`, or `null` when absent. |
| `runner_version` | Version of the runner package whose code wrote `meta.json`; taken directly from its `package.json`, not from launch arguments. An absent field means a historical run created before the runner: it does not violate the contract and is not evaluated under the runner sandbox rules. |
| `project` | Repository directory name used as the run grouping level. |
| `run` | Directory name of this run. |
| `resumed_from` | Non-empty string from `status.json#resumed_from`, preserved verbatim; otherwise `null`. Always present in a normal collect. |
| `finished_at` | Time when meta was computed, in ISO 8601. |
| `exit` | Numeric Codex code; `null` if none exists. |
| `status` | `OK`, `FAIL`, `LIMIT`, `UNAVAILABLE`, or `CAPACITY`. |
| `reason` | Reason for `FAIL`/`LIMIT`/`UNAVAILABLE`/`CAPACITY`; `null` for a normal `OK`. |
| `carried_from_earlier_run` | `true` if the claimed work is found in the chain's accumulated diff but not in the current run's delta. Always present in a normal collect. |
| `environment_changes` | Paths changed between snapshots that matched `env.json.environmentPaths`. They are visible in the audit but excluded from work evaluation. |
| `result_ok` | The result was read as JSON and contains the agent's primary required content field. |
| `events_bytes` | Size of `events.jsonl` in bytes. |
| `stderr_bytes` | Size of `stderr.log` in bytes. Normally it is **not** zero: a live probe on 2026-08-05 found hundreds of bytes of execpolicy refusals there for a completely healthy run. |
| `usage` | The `usage` object from `turn.completed`, exactly as sent by the CLI, with all numeric values; for multiple turns they are summed. |
| `tokens` | `input_tokens + output_tokens` from events; `null` if no turn reported usage. |
| `tokens_reported` | Whether a token count was recognized. `false` does not mean zero usage. |
| `profile` | The worker that was ordered, copied from `worker.json`: `model` (empty when nothing was pinned), `model_source` (`config` or `codex default`), `effort` and `effort_source` (`request`, `config` or `fallback`). `null` for runs recorded before the field existed. The reply prints it as one row, because a run answering on a model nobody ordered was invisible for three releases (2026-08-26). |
| `model` | The model the run was ordered with, from `profile.model` or the `-m` argument; `null` when nothing was pinned and Codex chose. The CLI never reports the model it served, so this is what was asked for, not what answered. |
| `sandbox` | The `--sandbox` argument the run was started with. When absent, the non-empty string `worker.json#resume.sandbox_mode` is used; otherwise `null`. Fresh runs keep their existing value. Resume argv uses `codex exec resume` with `-c sandbox_mode=read-only` and no `--sandbox` flag. |
| `env` | Contents of `env.json`; may be `null` for an old or early run. |
| `session_id` | Value of the `session id:` line from the log, or `null`. |
| `commands_executed` | Execution fact: `version` (`1`), `run` (this stream's completed command count, or `null` without a stream), `chain` (the sum across resumed turns, or `null` when unknown), `chain_runs` (predecessor names, nearest first), and `gap` (first chain failure, or `null`). |

Plan_80 E14 follows bare `status.json#resumed_from` names only, checking in order that each
predecessor is a directory canonically inside the same project runs folder (case-insensitively
on Windows), has not been visited, belongs to the current non-empty thread, has no disagreement
between stream and recorded thread IDs, and has its own command evidence; the first failure
sets `chain` to `null` and records `resume chain: <name> — <why>` in `gap`, with names bounded
to 60 characters.
Each predecessor contributes its stream's completed `command_execution` items, or its
non-negative integer `meta.json#commands_executed.run` and recorded `session_id` when the stream
is absent: `meta.json` survives retention, so pruned `events.jsonl` does not lose that evidence,
and stored `chain` totals are never added again.
A non-resume has `chain = run`, `chain_runs = []`, and `gap = null`; a valid resume sums its own
count and its predecessors (keeping `chain = null` when `run` is `null`); the scout execution,
startup-context coordinate, and advisor command-evidence checks now use `chain` (see
[verdict checks 12–13](verdict.md#resolvestatus-order)).

### Stop assessments

Plan_80 A2/A5 and E10/E12 separate the stop facts, their classification and diagnostic
treatment. After `resolveStatus`, `collect()` records `situation`,
`continuation_eligibility` and `treatment`. These fields do not change the verdict or status.
Only a `FAIL` reply with `result_ok: false` renders the three diagnostic rows below.
Automatic eligibility uses the frozen recovery policy and prior-attempt fact. The `resume:` grant is decided by `grantBlockers`
(policy version 1); an allowed grant prints a ready `resume:` line when an order id is recorded.
Collecting the same unchanged folder twice produces identical assessments.

`assessStop({ status, resultOk, agentWrites, threadId, stop, silencePolicy, recoveryPolicy, resumedFrom })` is pure.
It receives the resolved status, result usability, registry `writes`, the recorded thread
id, and frozen `meta.stop`, `meta.silence_policy`, `meta.recovery_policy` and
`meta.resumed_from`; it reads no files. Recollection
must use the same frozen session reference and policy rather than today's activity or
configuration. Stdout receipts are not the calibrated signal and cannot affect assessments.

`situation` has the following fields; missing facts are `null`, never inferred inactivity:

| Field | Value |
| --- | --- |
| `version` | `1`. |
| `kind` | First matching classification in the order below. |
| `cause` | `stop.trigger`, or `null`. |
| `silence_ms`, `silence_reason` | The `{ ms, reason }` returned by `silenceAgeMs(stop.session.at_reference, stop.stopped_at)`. This shared function is the only silence computation. An unavailable age is `null` with its evidence reason. |
| `threshold_ms` | Frozen `silence_policy.threshold_ms`, or `null` when unconfigured or absent. |
| `commands` | `{ state, reason, pending_count }` from `stop.session.at_reference.commands`; pending count is the array length, or `null` when absent. No call ids or command names are copied. |
| `session_state` | `stop.session.state`, or `null`. |
| `result_file_state` | `stop.result_file.state`, or `null`. Usability still comes from `resultOk`. |

Kind precedence is fixed:

1. A usable result (`resultOk: true`) gives `result-present`, regardless of status or stop.
2. Status `LIMIT` gives `limit`; status `UNAVAILABLE` gives `unavailable`; status `CAPACITY` gives `capacity`.
3. An older run with no stop record gives `evidence-unknown`.
4. Trigger `spawn-error` or `stream-error` gives `runner-error`.
5. Trigger `exit` gives `process-exit-no-result`, including exit code zero.
6. Command state `in-flight` gives `command-in-flight`.
7. For trigger `deadline`, unknown or absent command evidence, or a null silence age,
   gives `evidence-unknown`. Otherwise a null threshold gives `silence-unclassified`;
   silence greater than or equal to the threshold gives `silent-stall-candidate`, and
   silence below it gives `recent-activity`.
8. Anything else, including a null trigger, gives `evidence-unknown`.

Unknown evidence never becomes silence. A null threshold never becomes stalled or recent.

Plan_80 E15/O4 records `continuation_eligibility` as `{ version: 3,
automatic: { allowed, blocking_reasons }, grant: { allowed, policy_version: 1,
blocking_reasons } }`. Automatic `allowed` requires kind `silent-stall-candidate` and no
blocking reasons; grant `allowed` requires no grant blockers. The grant list
is exactly the result of the pure exported
`grantBlockers({ status, resultOk, agentWrites, threadId, stop })` from
`meta/stop-assessment.mjs`. Its exported `GRANT_POLICY_VERSION = 1` is stored as
`grant.policy_version`, so the recorded assessment and the later grant gate share the
same versioned predicate. An empty list records
`grant: { allowed: true, policy_version: 1, blocking_reasons: [] }`.
`situation` and `treatment` remain version 1.

The grant predicate returns every applicable safety/identity blocker in this fixed order:

1. `result-present` when a usable result exists.
2. `limit`, `unavailable`, or `capacity` for the resolved status.
3. `runner-error` when `stop.trigger` is `spawn-error` or `stream-error`.
4. `writer-role-not-approved` when registry `writes` is true.
5. `stop-record-missing` when there is no stop record (legacy runs).
6. `thread-unavailable` when there is no thread id.
7. `session-evidence-<state>` for any session state other than `observed`;
   `session-evidence-not-observed` when absent.
8. `process-tree-stop-unverified` unless `stop.tree_stop.state` is `stopped` or `exited`.
   A version-1 stop without `tree_stop` remains unverified.

Command evidence, silence thresholds and stall kind do not block a read-only grant:
Plan_80 S3 verified that writes are denied outside `%TEMP%`, so interrupted commands
leave no effects to reconcile there. The reply still shows `command=<state>` for the
orchestrator's decision. The grant list does not depend on the recovery policy.
Plan_80 S3 and two live `resume:` acceptances verified the read-only resume contract;
there is no resume-contract blocker on either path.

The automatic list starts with applicable frozen-policy blockers in this fixed order:

1. `recovery-policy-missing` when `recoveryPolicy` is null, absent or not an object.
   In this case, skip the next three policy checks.
2. Otherwise, `recovery-not-enabled` when `recoveryPolicy.enabled !== true`.
3. `recovery-brake-off` when `recoveryPolicy.brake?.value === 'off'`.
4. `recovery-budget-unconfigured` when `recoveryPolicy.budget_ms` is not a positive integer.
5. `recovery-attempt-spent` when `resumedFrom` is a non-empty string, regardless of whether
   a policy exists. E15 permits one automatic attempt per stalled pass; a continuation
   is never continued automatically again.

Then append every applicable factual blocker in the unchanged fixed order:

1. `result-present` when a usable result exists.
2. `limit`, `unavailable`, or `capacity` for the resolved status, even if the kind is `result-present`.
3. `writer-role-not-approved` when registry `writes` is true.
4. `thread-unavailable` when there is no thread id.
5. `session-evidence-<state>` for any session state other than `observed`;
   `session-evidence-not-observed` when absent.
6. `command-in-flight` for open commands, or `command-evidence-unknown` for unknown
   or absent command evidence.
7. `threshold-unconfigured` when `threshold_ms` is null.
8. `not-silent-stall` when the kind is known not to be a stall: never for
   `evidence-unknown` or `silence-unclassified` (whether the run stalled is unknown), nor
   for `silent-stall-candidate`.
9. `process-tree-stop-unverified` unless `stop.tree_stop.state` is `stopped` or `exited`,
   using the same evidence rule as the grant predicate.
10. `stall-not-established` when the kind is not `silent-stall-candidate` and no reason
    above applies, so a refusal always names why.

`treatment.effect` is always `diagnostic-only`: the action is advice and nothing executes it. Its action mapping is:

| Kind | Action |
| --- | --- |
| `result-present`, `limit`, `unavailable`, `capacity`, `silent-stall-candidate`, `recent-activity` | `retain-stop-facts` |
| `process-exit-no-result` | `inspect-exit-and-drain` |
| `command-in-flight` | `inspect-command-effects` |
| `evidence-unknown` | `inspect-evidence` |
| `silence-unclassified` | `calibrate-silence-threshold` |
| `runner-error` | `inspect-runner-error` |

Calibration means a package recalibration backed by evidence, not a host setting;
there is no host override. None of these actions authorizes or performs continuation.

The reply renders exactly these stored fields, without re-deriving their assessments
(Plan_80 A5), after `Artifacts:` and optional build `Worktree:`, before the log link:

```text
Situation: <situation.kind> · silence=<situation.silence_ms> ms · threshold=<situation.threshold_ms> ms · command=<situation.commands.state>
Continuation: automatic blocked (<automatic.blocking_reasons>) · grant blocked (<grant.blocking_reasons>)
Treatment: <treatment.action> · diagnostic only, nothing runs it
```

Null silence, threshold, and command state print `silence=unknown`,
`threshold=unconfigured`, and `command=unknown` respectively. Each continuation code list
is joined by `, ` in stored order, without truncation; its stored `allowed` flag selects
`allowed` (without empty parentheses) or `blocked (<reasons>)`.
No rows appear if `situation` is absent in an older record.

When `continuation_eligibility.grant.allowed === true` and this run's `status.json#order_id`
is recorded as a non-empty string, the reply inserts the registry-rendered ready resume line
immediately after `Continuation:` and before `Treatment:` (Plan_80 E13/O7):

```text
Ready resume line: resume: <run folder> — continue after <situation.kind> (continues that pass's Codex thread under order <order_id>).
```

A blocked grant or missing order id adds no line. Grant eligibility is decided only by
`grantBlockers` (policy version 1); automatic eligibility is assessed separately and
starts no continuation.

Every `OK`, `LIMIT`, `UNAVAILABLE`, and `FAIL` with a usable result keeps its reply unchanged.
`CAPACITY` replies have their own shape with no ready grant or diagnostic rows; see [verdict.md](verdict.md).
These rows are explanatory only: they change no status and execute no treatment.

### Silence policy

Plan_80 S2/E12 puts `silenceThresholdMs` beside each agent's `budget` in the package-owned
registry, delivered by package updates. It is not a seeded `config.json` key: seeded files are
written once and never overwritten, so a new seeded key would not reach installed hosts.
There is no host override in this release. The launcher resolves the policy once, before spawning
the worker; `collect()` copies that saved object, including its evidence, without recomputing it.

| Field | Value |
| --- | --- |
| `version` | Policy format version, currently `1`. |
| `role` | Registry role, such as `advisor`. |
| `phase` | Budget-declared phase; `default` for scalar budgets. |
| `threshold_ms` | Positive integer milliseconds, or explicit `null` for a role/phase that is not calibrated. Never zero or inherited from another role/phase. |
| `calibration` | The evidence record below, or `null` when the threshold is not calibrated. |

Only `advisor.advise` is calibrated: `threshold_ms: 996000`. Scout, build and review
(`default`), and advisor `scope`, each record `threshold_ms: null, calibration: null`.
The entire `silence_policy` object is `null` for an older run with no saved policy.

The frozen calibration catalog in `silence-policy.mjs`, keyed by `<role>.<phase>`, carries
the evidence rather than only a reference to a measurement that might later be moved or pruned:

| Calibration field | `advisor.advise` value |
| --- | --- |
| `id` | `plan80-s2-2026-10-13` |
| `measured_on` | `2026-10-13` |
| `codex_version` | `0.160.1` |
| `sample_runs` | `308` |
| `max_healthy_pause_ms` | `855163` |
| `min_stalled_silence_ms` | `1136878` |
| `rule` | `midpoint of the healthy maximum and the stalled minimum` |

The selected threshold is the midpoint rounded to seconds: `996000` ms, strictly between
the measured healthy maximum and stalled minimum. The bounds test keeps the number tied to
this evidence so it cannot drift outside the measured interval in a later round-number edit.
The policy is diagnostic only: stored stop assessments classify the evidence and supply the
unusable-result `FAIL` rows above, without changing the verdict or enabling recovery.

### Recovery policy

Plan_80 E15/O2b preserves the launcher's frozen `worker.json#recovery_policy` in
`meta.json`, including its calibration evidence and host brake. `collect()` never recomputes
it from today's registry or environment. The entire object is `null` for an older run
without a saved policy.

Plan_80 E16 therefore also carries `recovery_policy.watchdog` verbatim into `meta.json`, preserving the launcher's frozen arming, reason and package switch.

| Field | Value |
| --- | --- |
| `version` | Policy format version, currently `1`. |
| `role` | Registry role, such as `advisor`. |
| `phase` | Budget-declared phase; `default` for scalar budgets. |
| `budget_ms` | Measured budget in milliseconds for one automatic continuation, or `null` when that role/phase has no measured recovery budget. |
| `enabled` | Package-owned automatic recovery switch at launch. |
| `calibration` | Frozen calibration evidence for the measured budget, or `null` when no budget is measured. |
| `brake` | Frozen host brake `{ key, value, source }`: the environment key, its resolved `on`/`off` value, and `env`/`default` source. |

`brake.value: off` means the host switched automatic recovery off. The host brake can
only switch recovery off; it can never enable a disabled package switch. Plan_80 E15/O4
uses this frozen record for automatic eligibility and the stored `Continuation:` row.
It changes no verdict, status, situation or treatment and starts no automatic continuation.

### Early `writeFailure()`

A failure before normal `collect()` also creates `meta.json`, but its shape is narrower. It writes
`agent`, `project`, `run`, `finished_at`, `exit: null`, `status: "FAIL"`, `reason`,
`result_ok: false`, `events_bytes`, `stderr_bytes`, `tokens: null`, `tokens_reported: false`,
`model: null`, `sandbox: null`, `session_id: null`, and the available `env`.

This branch has no `carried_from_earlier_run` or `environment_changes`: the required snapshots and
result might not yet have existed. Consumers must distinguish an absent field from `false` or an
empty list.

An abandoned run (dead runner, no `meta.json`) is closed by one `meta.json` publication with the full reason,
then one `status.json` update, with no intermediate `failed` state. The final bytes are unchanged.

## `resume-note.md`

Resume runs only: the orchestrator's task body, as written but without surrounding blank lines, is saved as `resume-note.md` in the new
run folder for the record. It is never sent to Codex; `task.md` remains the package's continuation
prompt. The note is not a frozen input or a transport file, so retention keeps it.

## `questions.json`

The launcher writes the parsed questions for scout runs only, before assembling `task.md`, as an
array of `{ id, text, kind }`. The verdict reads this saved input rather than parsing `task.md` again,
because that file also contains runner-generated instructions. The orderer's `[context-only]` marker
preserves the distinction missed on 2026-09-22, when two honest startup-context answers were failed
for executing no command.

| Field | Value |
| --- | --- |
| `id` | Assigned subquestion identifier, such as `Q1`. |
| `text` | Question text with the leading `[context-only]` marker stripped, when present. |
| `kind` | `startup-context` for a marked question about the task, instructions, schema or environment supplied at startup; `code-required` otherwise. Only the orderer sets the marker, never the scout. |

An archived entry without `kind` is read as `code-required`; it does not gain the no-command
exemption. The task's sub-question list renders a marked question as `Q1 [context-only]: …`.

## `advisor-task.json`

The launcher writes the parsed advisor choices from the orchestrator's task file before assembling
`task.md`. The verdict judges this saved input rather than parsing `task.md` again, because that file
also contains runner-generated instructions and is the full prompt sent to Codex.

| Field | Value |
| --- | --- |
| `options` | Parsed entries from `## Options`, each with an option `id` and its `description`. |
| `paths` | Parsed list entries from `## Paths`; citations are judged against these paths and the applicable `missing_paths`. |
| `scope` | `advise` phase only: `{ run, predicted_risks, missing_paths }`, a snapshot of the continued `scope` run's `result.json` taken once, before the run folder exists. The `## Scope phase results` section of `task.md` is rendered from it and the verdict reads it; neither goes back to the scope run's folder. A scope result that cannot be carried is refused before any quota is spent. |

## `state-before.txt` and `state-after.txt`

The worktree snapshot a build run is judged by. The launcher writes `state-before.txt` before Codex
starts and the worker writes `state-after.txt` after it ends; the verdict, `meta.json#environment_changes`
and the worktree witness compare the two. One module owns the format:
`src/home/lib/meta/snapshot-format.mjs`.

Version 2 (Plan_73), written since 2026-10-01:

```text
# codex-bridge-state-v2
3	1	"src/changed.mjs"
-	-	"assets/logo.png"
U	42:<sha256 hex>	"areas/новый.md"
U	missing	"vanished.txt"
U	unreadable	"locked.db"
```

- The first line is the header, present even for a clean tree, so a clean tree is never confused with
  a missing or failed read.
- Every row has exactly three tab-separated fields: two state fields and the path as a JSON string.
  The path is the name git gave with `-z`, byte-exact: Cyrillic, tabs, newlines, quotes, backslashes
  and edge spaces survive, and nothing is trimmed.
- Tracked rows carry `git diff HEAD --numstat --no-renames` counters (`-	-` for binary files). A
  rename is a deletion plus an addition, two real paths.
- Untracked rows carry `U` and `<bytes>:<sha256>` of the content, so an edit that keeps the size is a
  change. `missing` — the file vanished between listing and reading; `unreadable` — it could not be
  read (on Windows, a file held by another process).
- The text ends with exactly one newline; an empty interior row is damage.

Version 1 (unversioned) is what older packages wrote: rows `<added>	<deleted>	<path>` and
`U	<bytes>	<path>`, names taken from git's quoted text output. It is still read, with blank rows
skipped as the old reader did, but a name git had quoted (starting with `"`) is refused as
`legacy-quoted-name`: its original spelling is already lost.

The version is decided by the first line alone, never by what the rows look like. Two snapshots of
different versions are never compared (Plan_73 D5): a run started before an update and judged after
it gets `FAIL` with `worktree snapshots cannot be compared (incompatible-versions)`, and the witness
stays silent for it. Restart such a run. A missing or damaged snapshot is `FAIL` as well, never a clean
tree.

## `flags-baseline.json`, `flags.txt` and `flags-coverage.txt`

Before a build run starts, the launcher copies the bytes of every tracked file dirty against HEAD
and every untracked file into `<run>/flags-baseline/`, then writes `flags-baseline.json`. The copies
are limited to 1 MiB per file and 32 MiB per run. A failed file listing makes the baseline incomplete,
never an empty baseline that could make earlier work look new.

| Field | Value |
| --- | --- |
| `version` | Baseline manifest format version. |
| `head` | Start HEAD used to recover the start content of files clean at launch. |
| `complete` | Whether the baseline capture is complete. |
| `reason` | Explanation when the baseline is incomplete. |
| `limits` | Capture limits: 1 MiB per file, 32 MiB per run. |
| `files` | Entries `{ path, tracked, state, copy?, bytes? }` for the start-dirty and untracked files. |

Each entry records the repository-relative `path`, whether it was `tracked`, and its capture `state`;
`copy` and `bytes`, when present, identify the saved copy and its byte count.

| State | Meaning |
| --- | --- |
| `copied` | Start bytes were saved for comparison. |
| `deleted` | The file was deleted at start; its start content is empty. |
| `absent` | The file was absent at capture; its start content is empty. |
| `truncated` | The file exceeded the per-file capture limit; start content is unknown. |
| `over-run-cap` | The copy could not fit within the run's capture limit. |
| `binary` | The file could not be captured as text for flag scanning. |
| `unreadable` | The file's start bytes could not be read. |

After the run, the worker writes `flags.txt` and `flags-coverage.txt`. Every start-dirty file and
every file the before/after snapshots show as changed is compared with its start content: the copy,
the start HEAD for a file clean at launch, or empty content for a new file. `git diff --no-index`
uses pinned flags, including `--ignore-cr-at-eol`; only added lines inside hunks are judged.

Flags are `test`/`it`/`describe` with `.skip` or `.only`, `NotImplemented`, and TODO/FIXME markers.
TODO/FIXME must follow a comment leader (`//`, `/*`, `#`, `<!--`, `--`, or a leading `*`), appear at
the line start, or follow a Markdown list prefix, such as `- [ ] TODO`. Test data such as
`['', 'TODO']` is not a flag. A moved existing marker is reported as added; this is an accepted
residual of judging added lines.

Unknown start content is a coverage gap, never an accusation: this includes every state except
`copied`, `deleted` and `absent`, an unreadable start commit, a failed diff, an over-limit end file,
or a missing baseline. Gaps go to `flags-coverage.txt`; the reply adds
`Flags coverage: incomplete — <first gap> (+N more)`. Flags never change the status.

On 2026-09-22 runs were flagged for a `skills/synced/` folder that existed before them and for test
data `['', 'TODO', '<phase>']` added by an earlier uncommitted run. The old scanner read the whole
dirty tree and the word TODO anywhere. The start baseline and marker boundaries keep that earlier
work and ordinary test data from being attributed to the current run.

The worker deletes `flags-baseline/` immediately after the scan; closing a run as abandoned removes
it too. The manifest stays and holds no file content.

## `git-before.txt`, `git-after.txt` and `diff.stat`

Human-readable only: `git status --porcelain` before and after the run and `git diff --stat` after it,
written with `-c core.quotepath=false` so a person sees real names. No code parses them — the verdict
reads the snapshots above — and they may still quote or abbreviate unusual names. Do not build a
consumer on them.

## Observation ledger

`state/handback-witness.json` and `state/dispatcher-model.json` keep observations in the branded
home, separately from run verdicts. They share the format owned by
`src/home/lib/observation-ledger.mjs`, but their adapters decide the keys, recovery evidence and
severity. Both are purge-only operator data, retained across update and ordinary uninstall.

On 2026-09-27 an old witness alarm still made `doctor` warn after clean handbacks on a newer host.
Plan_67 D8 separates what was last observed from what was last confirmed, so uncertainty cannot
erase an incident and recovery can clear its warning without erasing history.

### Format 1

| Field | Value |
| --- | --- |
| `format` | `1`. |
| `seq` | Nonnegative counter for the whole ledger; `0` in an empty ledger. Each observation increments it under the artifact's lock. |
| `entries` | Object keyed by an adapter-defined nonempty string. Empty in a new ledger. |

Each entry has these four fields:

| Field | Value |
| --- | --- |
| `lastObservation` | The newest observation of any verdict for this key. |
| `lastViolation` | The newest confirmed violation, or `null`; a later match does not erase it. |
| `lastMatch` | The newest confirmed match, or `null`; uncertainty does not replace it. |
| `history` | Up to 20 violation observations for this key, in increasing `seq` order, including `lastViolation` when present. Matches and undetermined observations do not enter this list. |

An observation contains positive integer `seq`, `verdict`, ISO timestamp `at`, string `detail`,
and optional plain JSON object `data`. The verdict is `violation`, `match` or `undetermined`.
Every observation replaces `lastObservation`; only a violation updates `lastViolation` and
`history`, and only a match updates `lastMatch`.

Ordering is by `seq`, never by timestamps: `at` is for display, and clocks can disagree. An entry
with a violation stays unresolved unless `lastMatch.seq` exceeds `lastViolation.seq`. It is then
recovered, with the incident still present. With no violation, a match means clean; otherwise the
entry is undetermined. An absent entry is unobserved. An undetermined observation clears neither
a cause nor the dispatcher-model warning latch.

Sequence allocation and atomic replacement of the JSON happen under the same artifact lock,
through `withHomeFileLock` and `writeHomeJsonAtomic`; the two files have independent counters and
locks. A missing file reads as empty. An unreadable or invalid ledger is marked corrupt, not
silently reset, and writers refuse to overwrite it. `doctor` reports an unreadable record as a
warning naming its file.

### `state/handback-witness.json` — version 2

| Field | Value |
| --- | --- |
| `version` | `2`, the witness wrapper version; distinct from the nested ledger's `format: 1`. |
| `ledger` | The observation ledger above. |
| `intercepted` | Map of host transcript version (or `unknown`) to the latest intercepted handback timestamp. Includes refused attempts and is never proof of recovery. |
| `legacy` | Preserved older alarms with `at`, `hostVersion`, `detail` and `disposition`: `legacy-untyped-unverified` or `unclassified`. These are history, outside the confirmed-violation ledger. |

Every witness observation's `data` contains `cause`, `hostVersion` (string or `null`) and
`agentType` (string or `null`). Unknown hosts use `unknown` in the key. Causes and their recovery
boundaries are:

| Cause / key | What disproves it |
| --- | --- |
| `missing-ids` / `<host>\|<type>\|missing-ids` | A later stop of that dispatcher type on that host with both `session_id` and `agent_id`. |
| `tools-outside-gate` / `<host>\|<type>\|tools-outside-gate` | A later complete, readable audit with every tool call accounted for, healthy gate state, no prior audit alarm, a delivered runner handback and no receipt conflict. Refused attempts and synthetic gate `FAIL`s are not recovery. |
| `missing-agent-type` / `<host>\|missing-agent-type` | A later recognized dispatcher stop on that host with the type and both ids. The missing type is not guessed from a runner command. |

An untyped stop is a violation only with evidence bound to that stop: healthy gate state with
a registered type and actual gate activity, or an assistant Bash call executing a standalone
runner command for a registered role. No evidence, or unavailable evidence, is undetermined;
it cannot clear an earlier violation. `handbackWitness` warns for unresolved causes on any host
with dispatcher activity in the last 24 hours, naming each violation's host with `host <version>:`;
it never fails `doctor` or blocks work. Recovery, unverified legacy alarms and unresolved causes
on hosts outside the window remain a history sentence with counts. With no active hosts it is
`ok` and says “No dispatcher activity in the last 24 hours.” Activity comes from the latest
recorded session activity, intercepted handback or witness/model observation for each host version,
not session liveness (Plan_67 D12).

The old `{lastSeen, alarms}` form is interpreted before normalization: host-version sightings
become `intercepted`, while SDK-based sightings cannot identify a host. Exact old “host omitted
agent_type” alarms without dispatcher evidence become `legacy-untyped-unverified`, with their
timestamp, detail and host version where known. This preserves the 13 unverified alarms found
across nine hosts without inventing confirmed violations or recovery. Recognized missing-id and
tool-gate alarms enter their ledger keys as violations; other old alarms remain `unclassified`.
Older SDK-based alarms have unknown host identity. Migration is idempotent and persists only on
the next locked witness write; `doctor` interprets the old file in memory without changing it.

### `state/dispatcher-model.json`

This file is directly a format-1 ledger, with no witness wrapper. Each key is
`<host>|<agentType>` (host transcript version or `unknown`). At `SubagentStop` the reply guard
reads assistant `message.model` entries before any handback exit and compares their parsed
families with the installed package contract. It does not use a UI's parent-model label, the
call's `(inherit)` display or a table of volatile model ids.

| Observation `data` field | Value |
| --- | --- |
| `hostVersion` | Transcript host version, or `null`. |
| `agentType` | Registered dispatcher type. |
| `pinFamily` | Unanimous installed family, or `null` when the contract is undetermined. |
| `parsed` | Array of distinct parsed model families seen in assistant entries, not raw model ids. |
| `unparsed` | Count of model strings whose family could not be parsed. |
| `comparison` | `installed-contract`; the host does not report which installed definition it selected. |
| `pinReasons` | Present when `pinFamily` is `null`: reasons the installed contract could not be determined, including affected paths where applicable. |

The contract requires `.installed.json` format 2, a complete inventory, no legacy partition and
at least one owner. Every recorded root's `agents/codex-bridge/<type>.md` must have the required
frontmatter `name` and agree on a parseable family. Missing files, malformed definitions or
disagreement produce an undetermined pin, rather than reconstructing host precedence.
An old record migrated without a terminal stays `inventory: incomplete` until the operator
accounts for every host using the home. `codex-bridge inventory confirm` sets `.installed.json`
`inventory` to `complete` and removes `legacy`, leaving every other field as read, including
owners and fingerprints. It does not create a model match or clear a violation; the next
dispatcher observation determines the comparison (Plan_67 D11).

With a known pin, any parsed foreign family is a violation; one or more parsed families all
matching is a match. Unparseable model strings are not evidence, and no parsed family or an
unknown pin is undetermined. A violation raises a same-turn alarm even if recording it fails.
The order gate's warning latch projects across all host entries of that type: the greatest
violation `seq` stays active until a greater match `seq`, without rewriting the old host's entry.

`doctor` prints each active host's `dispatcherModel:<type>` entries as separate rows prefixed
`host <version>:`: a latest violation is `fail`, and a model `fail` on any host with dispatcher
activity in the last 24 hours reaches exit code 1; a latest undetermined observation is `warn`,
retaining any undisproved incident; a latest match is `ok`, including recovery. No model entries
for active hosts produces an `ok` `dispatcherModel` row saying “Not observed in the last 24 hours
— recorded when a dispatcher stops.” Hosts outside the window remain one history sentence with
entry and unresolved violation counts; recovered incidents stay in history rather than becoming
permanent warnings (Plan_67 D8/D12). Contract checks still use the newest observed host.

### `state/load-witness.json`

The `load-witness` hook records rules-core `InstructionsLoaded` events at `session_start` in
the branded home. This is a `{ sessions: {} }` record, not an observation ledger. Each session
id maps to an entry with the following fields:

| Session field | Value |
| --- | --- |
| `loads` | Array of core loads; the same exact path is recorded only once per session. |
| `transcriptPath` | Host-supplied transcript path, when supplied; used later to identify this session's host version. |
| `cwd` | Host-supplied working directory, when supplied. |

Each load contains:

| Load field | Value |
| --- | --- |
| `path` | Host-supplied path ending in `/rules/codex-bridge/core.md`; candidate detection accepts either slash spelling and ignores case. |
| `loadReason` | `session_start`; other load reasons are not recorded. |
| `memoryType` | Host-supplied memory type, or `null`; it is not evidence of which host loaded the core. |
| `sha256` | SHA-256 of the core's bytes, or `null` when reading failed or the bounded read found an oversized file. |
| `at` | ISO timestamp of the observation. |
| `readError` | Present on a read failure: the filesystem error code, or `null` if unavailable. |
| `hashSkippedReason` | Present when the file exceeds the byte ceiling: `core-too-large`, with `sha256: null`. |

The package core has a `CORE_CHARACTER_CEILING` of 2,400 characters. Its read is bounded by
`CORE_BYTE_CEILING` (7,200 bytes, three UTF-8 bytes per UTF-16 unit), plus one byte to detect
overflow, so a foreign large file cannot make the hook read without limit. Sessions whose newest
load is older than 30 days, or whose loads array is invalid, are dropped on the next write.
Updates use the load-witness lock and atomic JSON replacement. A missing file reads as empty;
an unreadable or corrupt record is preserved and writers refuse to overwrite it. The observing
hook always exits 0, including on missing evidence or a write failure.

The 2026-10-10 live event fired before its transcript existed. Recording therefore happens
without a version; `doctor` later reads the version from that same session's transcript, never
from the current `PATH` host, a neighboring session, `memoryType` or an entrypoint. Unresolved
transcripts remain pending evidence.

`claudeRulesLoad:<host version>` is `ok` only when the latest witnessed load at the installed
owner's exact core path has the current package hash for that host version. Path comparison
normalizes separators and ignores case on Windows. A newer differing hash invalidates an older
match; a newest `core-too-large` load warns even after a matching load. Missing/stale evidence
warns with a request to open a new Claude Code session and rerun `doctor`. Before installation,
on a corrupt witness or without an identified host, a general `claudeRulesLoad` row warns.
These rows never fail: absence of a hook record cannot prove a load failure. The separate
`claudeRules` row checks installed bytes, not witnessed loading.

## `events.jsonl` and `stdout-receipts.jsonl`

`events.jsonl` preserves Codex stdout bytes. Alongside it, the runner appends one JSON object
per saved stdout line to `stdout-receipts.jsonl` (Plan_80 S1, E10/A4 dual-evidence):

| Field | Meaning |
| --- | --- |
| `seq` | 1-based line number in `events.jsonl`. |
| `offset` | Byte offset of the line start in `events.jsonl`. |
| `bytes` | Saved byte length, including the newline for complete lines. |
| `received_at` | ISO wall-clock time of the stdout data chunk that completed the line. |

Lines completed by the same chunk share its timestamp. A final fragment without a newline
has `incomplete: true`; its timestamp belongs to the chunk that delivered its last byte,
never the later flush. At the events size cap, one terminal record
`{ "truncated": true, "received_at": "<ISO>", "written_bytes": W }` records the cutting
chunk's time and the bytes saved to `events.jsonl`; no further receipts are written.

If receipts cannot be written, the runner stops writing them and appends one line
`run-codex: cannot write stdout-receipts.jsonl: <message>` to `stderr.log`. Codex continues:
the verdict does not read receipts. The resolved `runCodex` result adds a `receipts` summary
with `lines` (saved events lines, including a final fragment), `last_received_at` (last line,
fragment or truncation receipt, initially `null`), `incomplete`, `truncated`, and `write_error`
(message or `null`). Observation counts continue even if the receipts file fails.

Receipts are transport files removed by retention and gentle pruning, like `events.jsonl`.
They are diagnostics only, never the silence signal: stdout carries no timestamps and goes
silent earlier than the Codex session log.

## Stop record

Plan_80 A2/A4 (`dual-evidence`) records stop cause, activity and evidence availability as
independent facts. The runner writes `status.json#stop`, because Codex can write `events.jsonl`.
`meta.json#stop` preserves that observation; neither the verdict nor any reply uses it.

| Field | Meaning |
| --- | --- |
| `version` | `2`. Version-1 records (0.6.16 and earlier) have no `tree_stop`. |
| `trigger` | First observed stop trigger: `exit`, `deadline`, `stream-error`, or `spawn-error`; `null` (with `stopped_at` and `process_error`) when the run settled with no trigger observed first. |
| `stopped_at` | ISO wall-clock time when that first trigger was observed, never the later settlement time after draining. |
| `exit_code` | Code from the child's `exit` event; `null` if that event never fired (or exited by signal). |
| `signal` | Signal from the child's `exit` event; `null` if absent or that event never fired. |
| `process_error` | Error message for a first stream/spawn error trigger; otherwise `null`. |
| `stdio_drained` | The resolved `runCodex` drain observation, also recorded separately in status. |
| `elapsed_ms` | The resolved `runCodex` elapsed time, also recorded separately in status. |
| `tree_stop` | Codex process stop evidence: `{ requested, method, status, error, child_exit_observed, state }`; rules below. |
| `receipts` | The stdout receipt summary: `lines`, `last_received_at`, `incomplete`, `truncated`, `write_error`. |
| `result_file` | One observation of the selected agent's result file, with `state` as below. |
| `session` | Read-only observation of this thread's Codex session-log activity, with fields and states below. |
| `watchdog` | Final silence-watchdog `record()` snapshot (below), or `null` when the run had no watchdog record. |

`exit` means the child's `exit` event came first. `deadline` means the budget timer fired
while the child was alive. `stream-error` means a log stream failed and the runner stopped
Codex; `spawn-error` means the child emitted `error`. A later exit supplies its code/signal
without replacing the first trigger or its timestamp. Receipt write failures remain receipt
diagnostics and do not stop Codex.

Plan_80 E13/O1 records the **last** kill attempt in `tree_stop`, independently of the first
stop trigger. `requested` says a kill was attempted; `method` is `taskkill`, `kill` (Windows
shell-only fallback), or `signal` (POSIX), and is `null` without an attempt. `status` is the
taskkill exit status or `null`; `error` is its spawn error message, or the taskkill failure
status/error that caused the fallback, otherwise `null`. `child_exit_observed` records whether
the child's `exit` event fired, including a signal exit with a null code.

On Windows, `state: stopped` requires the last attempt to be `taskkill` with status `0`
**and** the child's `exit` event. With no kill requested, an observed exit means `exited`:
`cmd /c` waits for Codex, so its exit proves Codex is gone. Every other case is `unverified`,
including a `kill` fallback followed by exit: killing only the shell can leave the
2026-07-31 Codex orphan alive. Off Windows the child is Codex itself: an observed exit means
`stopped` if a kill was requested, otherwise `exited`; without an observed exit it is
`unverified`. This evidence concerns Codex itself, not proof that every descendant is gone.
The continuation assessments consume this evidence; classification of the situation is unchanged.

`result_file.state` distinguishes presence from usability: `missing` means no file;
`unreadable` means reading failed and includes an `error` message; `malformed` means the
file was read but was not JSON; `unfilled` means parsed JSON failed the agent registry's
`filled` check; `filled` means that check passed. The runner reads the result exactly once
for this record and adds no new file write. Later changes to artifacts cannot rewrite the
record through `collect()`.

### Silence watchdog record

Plan_80 E16/O3b adds `stop.watchdog` without changing stop record version `2`.
The worker supplies a watchdog even for `off`; a direct `runCodex` call without one
records `null`. Older records may lack the field entirely.

| Field | Meaning |
| --- | --- |
| `version` | Watchdog record version `1`. |
| `arming` | Frozen `off`, `shadow`, or `armed` state. |
| `threshold_ms` | Frozen silence threshold, or `null` when unconfigured. |
| `interval_ms` | Poll interval in milliseconds; `null` for `off`. |
| `checks` | Number of completed session-activity reads, including confirmation reads. |
| `last_observation` | `null` before any completed read; otherwise `{ at, state, commands, silence_ms }`. |
| `decision` | `null` without a confirmed stall; otherwise `{ at, silence_ms, confirmed_at, action }`, with `action` of `recorded`. |
| `fault` | Reader/check error message, or `null` without a fault. A fault disables subsequent reads and never stops the run. |

The decision uses two reads of the Codex session log. A shadow decision never kills
Codex; the diagnostic record starts no continuation and changes no verdict or reply text.

### Session activity

`session` is read once using `events.jsonl`'s `thread.started` id and
`status.json#started_at`. The independent reader uses `resolveCodexHome()` and first looks in
`sessions/YYYY/MM/DD/` for the local start day, the day before, and the day after. If no matching
rollout is found, it searches date-shaped year/month/day directories, newest day first, using
the same rollout filename pattern and taking the first match. Other directory shapes are not
searched. Plan_80 E13/O9 requires this fallback because a resume appends to the thread's original
rollout file, which may be days older than the run. A missing `sessions` folder remains `missing`.
Plan_80 S1/S2 calibrated silence on session-log record
times because stdout goes silent earlier. This observation does not change the verdict.

| Session field | Meaning |
| --- | --- |
| `state` | `not-observed`, `missing`, `unreadable`, `empty`, `unrecognized`, `incomplete`, or `observed`, as below. |
| `reason` | Read error message for `unreadable`; violated format rule and line number for `unrecognized`, without log content; otherwise `null`. |
| `file` | Rollout file name only, never its path; `null` if no file was found. |
| `last_record_at` | Timestamp of the last valid record of any kind. Available for `observed` and `incomplete`; otherwise `null`. This is the activity clock. |
| `last_record_kind` | That record's `type`, or `type/payload.type` for `event_msg` and `response_item` when the sub-kind is present; otherwise `null` with the timestamp. |
| `records` | Number of valid records read before the end or a format violation, including `token_count` events. |
| `unknown_kinds` | Distinct top-level `type` values outside the known list; these do not invalidate an otherwise valid envelope. |
| `sampled_at` | Time the reader ran. Never an activity clock; neither file mtime nor heartbeat is activity either. |
| `longest_gap_ms` | Largest timestamp difference between consecutive valid records read in file order across the whole thread; `null` with fewer than two records. |
| `longest_quiet_gap_ms` | Largest such gap with no tool call open throughout the interval. `null` when whole-thread command evidence is `unknown`, there are fewer than two records, or no interval is quiet. |
| `pass_longest_quiet_gap_ms` | Largest quiet interval from `startedAt` to the first record at or after it, then between consecutive qualifying records in file order. Uses separate command evidence fed only those records; an interval counts only with no pass tool call open throughout it. `null` when the session is not read, no record qualifies, no interval is quiet, or pass command evidence is `unknown`. Plan_80 E25(3): a continuation shares its parent's thread, so whole-thread gaps can include the parent's stall and the wait until resume. |
| `at_reference` | `null` without `referenceAt`; otherwise `{ as_of, last_record_at, last_record_kind, records, commands }` using only records with timestamps at or before that reference. |
| `sandbox_witness` | Always present: `{ state, policy, at }`. For an `observed` session, the last qualifying `turn_context` in file order gives `{ state: 'observed', policy, at }`, where `policy` is its non-empty string `payload.sandbox_policy.type` and `at` is its timestamp. Without a qualifying record it is `{ state: 'absent', policy: null, at: null }`. Every other session state gives `{ state: 'not-observed', policy: null, at: null }`. |

Plan_80 E13/O9 adds `stop.session.sandbox_witness` as evidence of the sandbox actually assigned
to this run's turns. Only records timestamped at or after the run's `startedAt`
(`status.json#started_at`) qualify: an original turn before a resume cannot vouch for the
resumed turn. Only the policy type string leaves the reader; no other sandbox payload fields
are retained. An incomplete or otherwise unobserved session never supplies a witness, even
when a qualifying record preceded the failure. This evidence lets a later order reject a
resume whose witnessed policy is not `read-only`; this reader does not enforce that verdict.
The verdict fails a resume run whose witness is `observed` and not `read-only` (`docs/verdict.md`, item 7).

Plan_80 A5/E12 adds these fields without changing stop record `version: 1`, verdicts or
replies. Older runs without these fields have not observed this evidence. The runner passes
`stop.stopped_at` as the reader's optional ISO `referenceAt`: the first stop trigger owns
the reference, never the later drain or collection. `as_of` is that reference time; the
snapshot's activity fields and record count preserve file order within the qualifying records.
The raw session activity and gap maxima still cover all records read, including later ones.
An invalid reference produces null snapshot times, zero records, and unknown commands with
`reason: "reference time invalid"`; it does not change the raw reader state.

`at_reference.commands` contains `{ state, reason, pending }`. Calls are `response_item`
records with `payload.type` of `custom_tool_call` or `function_call`; their matching outputs
are `custom_tool_call_output` or `function_call_output`, paired by string `payload.call_id`.
A call starts at its record timestamp; an output after the reference cannot close it there.
The conservative rules, also applied across the whole thread for quiet-gap evidence, are:

| Evidence | Command state and reason |
| --- | --- |
| Reader state other than `observed` | `unknown`, `session <state>`. A valid prefix never proves command absence in an incomplete or invalid log. |
| Any call or output without a string `call_id` | `unknown`, `tool record missing string call_id`. |
| Output without an earlier call | `unknown`, `orphan tool output`. |
| Any `wait` call, including a completed one | `unknown`, `asynchronous command lifecycle`: an `exec` output alone does not prove that an asynchronous command finished. |
| Open call named something other than `exec` | `unknown`, `open tool <name>` (`unknown` for a missing/non-string name). |
| Only open `exec` calls remain | `in-flight`, null reason, with each `{ call_id, name, called_at }` in `pending`. |
| All checks passed and no call remains open | `none`, null reason, empty `pending`. |

Unknown command evidence has empty `pending`. Completed non-`exec` calls other than `wait`
do not themselves make the lifecycle unknown, but their open intervals are not quiet.
Only structural call ids, tool names and timestamps leave the reader; command input,
output, messages and other payload text never do.

The pure exported `silenceAgeMs(atReference, referenceAt)` is the only place silence age is
computed. It returns `{ ms, reason }` from session-log records only: reference time minus
the snapshot's `last_record_at`, including exactly zero at the boundary. It reads no files
and accepts no stdout receipts, `events.jsonl` activity, heartbeat or file times. Invalid
reference time returns null with `reference time invalid`; unavailable reader evidence
returns null with `session evidence <state>`; absent/invalid last-record time or a negative
difference returns null with `no session record before reference`. Command lifecycle
uncertainty alone does not invalidate an observed session timestamp.

`not-observed` means no thread id was available, or no valid run start time to pick the day
folder (`reason: "run start time unknown"`; the reader never throws for it and never guesses
today's folder). `missing` means none of the three day
folders contained the thread's rollout. `unreadable` means discovery or reading failed.
`empty` means zero records in an empty file. `unrecognized` means a non-final line is not
JSON, an envelope is invalid (string timestamp/type, numeric ordinal, object payload are
required), the timestamp does not use `YYYY-MM-DDTHH:mm:ss.sssZ`, or the first
`session_meta.payload.id` differs from the thread id. BOM and CRLF are outside the format.
The rule and line number are reported without echoing values from the log.
`incomplete` means the last line lacks LF or cannot parse and every earlier line is valid;
activity from valid records is retained, including a valid final record without LF.
`observed` means all records are valid and LF-terminated. Structural timestamps and kinds
and structural tool call ids/names are the only log fields exposed; payload text, metadata
and other identities are never returned.

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
- `state/load-witness.json` records session-start core paths and hashes in the branded home,
  independently of run verdicts; `doctor` joins those sessions to their transcripts for host-version evidence.
- Recomputing an old run takes `environmentPaths` from its `env.json`, not from the current
  `config.json`.
