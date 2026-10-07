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
| `phase` | Resolved phase copied from `worker.json` (or `status.json` if needed); `null` for runs made before phases existed. |
| `sufficient` | Advisor only: the boolean from the advisor result, or `null` when the result did not say. An insufficient scope can still be a valid `OK` result. |
| `missing_paths` | Advisor only: paths the result identified as needed, or `null` when the result did not say. |
| `advice` | Build only: copied from `status.json#advice`, or `null` when absent. |
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
| `profile` | The worker that was ordered, copied from `worker.json`: `model` (empty when nothing was pinned), `model_source` (`config` or `codex default`), `effort` and `effort_source` (`request`, `config` or `fallback`). `null` for runs recorded before the field existed. The reply prints it as one row, because a run answering on a model nobody ordered was invisible for three releases (2026-08-26). |
| `model` | The model the run was ordered with, from `profile.model` or the `-m` argument; `null` when nothing was pinned and Codex chose. The CLI never reports the model it served, so this is what was asked for, not what answered. |
| `sandbox` | The `--sandbox` argument the run was started with, or `null`. |
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
it cannot clear an earlier violation. `handbackWitness` warns only for unresolved causes on the
current observed session host and never fails `doctor` or blocks work. Recovery and other hosts
remain history; no observations is `ok`.

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

With a known pin, any parsed foreign family is a violation; one or more parsed families all
matching is a match. Unparseable model strings are not evidence, and no parsed family or an
unknown pin is undetermined. A violation raises a same-turn alarm even if recording it fails.
The order gate's warning latch projects across all host entries of that type: the greatest
violation `seq` stays active until a greater match `seq`, without rewriting the old host's entry.

`doctor` prints `dispatcherModel:<type>` only for current-host entries: a latest violation is
`fail` with exit 1; a latest undetermined observation is `warn`, retaining any undisproved incident;
a latest match is `ok`, including recovery. No current-host observations produces an `ok`
`dispatcherModel` row saying “Not observed yet”. Other hosts and recovered incidents are history,
not permanent warnings (Plan_67 D8 clarification, 2026-10-07).

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
