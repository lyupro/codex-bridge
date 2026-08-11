# Run Lifecycle

## Participants

`run-codex.mjs` selects one of two branches. A normal invocation starts the launcher. The internal
`--worker <run directory>` invocation starts the worker. After the processes detach, their only data
connection is `worker.json`.

The launcher does not wait for the verdict: it starts the run and exits. The caller returns for the
verdict by invoking the same command again with the same job label — `attach.mjs` attaches it to the
existing run instead of starting a second one. When startup and waiting were a single invocation, the
calling shell's time limit looked like a dead run: on 2026-08-03 one job produced six runs, four of
which were never accounted for at all.

## First failure point: the orchestrator gate

Before the launcher starts, Claude Code invokes the `PreToolUse` hook `order-gate.mjs` on every attempt
to call a dispatcher. The gate reads the job text from `tool_input.prompt` and checks it against the
single table in `src/required-inputs.mjs`: `codex-scout` and `codex-review` require a job label, while
`codex-build` requires a label and full `scope`. A missing value or obvious placeholder (`TODO`,
`<label>`, and so on) is rejected here, before either the subagent or Codex starts and before quota is
spent. A real label and scope allow the call to continue.

This is a producer-side check: the agent prompt also receives this list from the same table during
installation, but the gate protects the caller before control passes to the dispatcher. Only an `allow`
response begins the launcher sequence below.

## Launcher sequence

Order matters: early refusals must happen before Codex is invoked, and the worker must receive the
complete job before detaching from the launcher.

1. `loadRunEnv()` reads `run-config.json` and fixes the environment flags. A configuration error ends
   the command without creating a run directory.
2. `parseArgs()` validates the CLI, including mandatory `--agent` and `--order-id` for all modes,
   `--scope` for build, and at least one `--question` for scout. The orchestrator supplies the job label
   and subquestions; the runner does not invent them and will not start without them. A flag name in
   place of a value (`--question --continue`) counts as a missing value. `--effort` is checked against
   the Codex set (`none|minimal|low|medium|high|xhigh|max`) here as well — before invocation, not from
   an API response.
3. The launcher reads stdin and rejects an empty task.
4. The repository root is determined through git; `--repo` is used for a non-git directory.
   Immediately afterward, `validateScope()` checks scope patterns against repository contents and
   rejects a pattern that cannot match: an absolute or drive path, backslashes, `..`, or a pattern that
   found nothing. This check runs for all three agents and before creating the run directory; paths from
   `--scope-new` (only for `codex-build`) are exempt from the requirement to exist. The repository root
   is needed before validation, which is why this check belongs here rather than in `parseArgs()`.
5. `markAbandoned()` closes earlier directories with `state=running` if their pid is already dead. Such
   a directory receives not only a marker but also a verdict: `meta.json` with status `FAIL` and a reason
   listing the files by which the current tree differs from that run's `state-before.txt`. The tree
   snapshot is passed as an argument — `meta/` intentionally makes no git calls. The list is honest but
   does not prove authorship: the comparison happens at the start of a later run, so it may include
   someone else's work, and the reason says so. The directory remains in `abandoned` state; otherwise
   the detached HEAD protection would stop seeing it.
6. `abandonedBranchDrift()` checks whether an abandoned run left the repository in detached HEAD. If it
   did, startup is rejected for all three modes, prints `git checkout <branch>`, and does not execute it.
   A branch-name difference is not a refusal: switching branches is normal operator work. The block
   clears itself as soon as the repository is back on a branch.
7. If `--slug` is absent, the runner takes it from the mandatory job label and applies the sanitizer
   `[^A-Za-z0-9._-]+` → `-`; a result with no letters or digits is rejected before creating a directory.
   Then `chainRuns()` finds runs from the same repository by three signals: the same `slug`, the same
   task-text fingerprint, or the same job label. A matching chain without `--continue` stops startup
   before a new directory is created. Old-contract directories with a generic slug such as `build` are
   not lost: the saved job label or fingerprint finds them. Only runs that had a Codex session count:
   a directory with `state=aborted_pre_start` (and its old-contract equivalent) is excluded — it spent
   no quota and contains nothing to continue. The chain itself remains complete: it is the audit view,
   and the rejected run remains visible in it.
8. For build, a live writing run in the same repository is checked.
9. A unique `<date_time>_<slug>` directory is created; on a name collision, `-2`, `-3`, and so on is
   appended.
10. The first artifact written is `status.json` with `state=running` and the launcher pid. Stdout then
    receives the line `RUN=<directory>`.
11. A conflicting writing run or unavailable Codex CLI is closed through `meta.json` and `status.json`
    with status `FAIL` and state `aborted_pre_start`; no paid call has occurred. The separate state is
    not cosmetic: it lets the next startup distinguish an empty directory from a run backed by spent
    quota.
12. For review, the diff area is computed and written to `scope.txt`. For scout, subquestions passed via
    `--question` are written to `questions.json` in the same order (`Q1..Qn`); the task text is not the
    source of this list. For build, `--scope` patterns are written to `scope.txt`.
13. `env.json` is written, followed by `task.md` and `schema.json`. `schema.json` is not only the Codex
    response format: it tells the verdict whether the run was required to declare an outcome (`outcome`
    in `required`), so an old directory is judged by the contract of its own day — see
    [verdict.md](verdict.md).
14. For build, `head-before.txt`, `branch-before.txt`, `git-before.txt`, and `state-before.txt` are
    captured. An empty `branch-before.txt` means detached HEAD, not missing data.
15. argv for `codex exec` is assembled; an argument unsafe for `cmd.exe` produces an artifacted `FAIL`
    before Codex is invoked.
16. `worker.json` is written — the complete job for the second half.
17. Detachment point: the launcher creates a detached worker with `stdio: ignore`, calls `unref()`, and
    updates `status.json`, replacing the active `pid` with the worker pid and adding `runner_pid`.
18. The launcher prints a `STARTED` line with the mode, slug, job label, and worker pid, followed by
    instructions for returning for the verdict, then exits with code `0`. It no longer waits here.

## Attaching by job label

A repeated invocation with the same label does not create a second run. The check occurs before
directory creation, immediately after finding the chain and before the `--continue is required` refusal
(step 7):

- **A run with this label already has `reply.txt`** — the verdict is printed from disk; the repeat
  responds rather than refusing.
- **There is no `reply.txt`, and the pid is alive** — the invocation prints
  `ATTACH=<directory> started=<time>`, waits for `reply.txt`, and prints it. The next line states
  explicitly that this is the response from the previous run started at the given time and that no new
  work was started. Codex is not invoked and quota is not spent. An interrupted repeat damages nothing:
  the next invocation attaches to the same run.
- **There is no `reply.txt`, and the pid is dead** — this is an abandoned run with nothing to attach to;
  the earlier path applies (`markAbandoned()` has already marked the directory, then the `--continue`
  refusal takes effect).
- **`--continue` was passed** — attachment does not happen at all: the orchestrator has read the previous
  response and requests a new attempt.

## Continuation authorization

The gate always parses the task text for authorization. If an authorization line exists but
`--continue` was not passed, the call is rejected before `attach()`, directory creation, and quota use.
`--continue` without authorization from the orchestrator is also rejected. Authorization is a line in
the task text next to `order id:` and `scope:`:

```
continue: 2026-08-05_092913_plan14-build — LIMIT at step 3, tests unwritten
```

It names the run after which execution continues and gives the reason. The line form constitutes
authorization, not the existence of the named directory: after `continue:` there must be a readable
directory name, `—`, and a reason. A typo in the name is still authorization in the wrong form for the
directory check: the runner does not silently replace it with the correct name. Mentioning `continue:`
in ordinary prose is not authorization.

All refusals are free:

- authorization is absent, or its value is a placeholder (`<...>`, `TODO`) — refusal;
- the named directory does not exist in the project's runs directory — refusal with the same hints;
- the named run is not the last in the chain — refusal.

If authorization exists but the flag was omitted, the refusal names the exact directory of this task's
last run, its status and reason, and prints a ready-to-use authorization line for the retry. If the
directory is absent, all three hints are still provided; the entered name is not substituted.

The last rule makes authorization single-use: continuation appends a later run to the chain, so the same
line stops matching by itself — without a counter or new state. The named run is recorded in
`status.json` as `continued_from`; this is an investigation trace, not a validation input.

Without the line, a normal repeat without `--continue` can still safely attach to the previous run; a
line without the flag cannot pass through `attach()`. Therefore the `PreToolUse` job-label gate does not
require authorization: the decision to continue originates inside the subagent, and requiring it for
every call would reject legitimate first attempts. The 2026-08-05 incident caused this rule: after
receiving an honest `FAIL`, the dispatcher assigned itself a second attempt using 75,691 tokens of
someone else's quota and invented work the job had not requested. The
`2026-08-10_220535_plan25-2-install-table-two-roots` incident showed that without this ordering an old
response could look like the verdict for a new job.

## Continuation limit

A limit applies on top of authorization: `--continue` is permitted once per job label and only after a
run with a recorded verdict:

- no runs with this label — continuation is allowed;
- one run with a verdict — allowed;
- one run without a verdict — refusal: the run may still be editing the tree, and a repeat without
  `--continue` will attach to it;
- two or more — refusal naming the spent runs; another attempt requires a new job label from the
  orchestrator.

Only runs with this label count, not the entire chain. The chain also links runs by slug and task-text
fingerprint — catching a repeat that renamed itself — but applying the limit to the chain would break
the promised exit: a new label joins the same chain through the fingerprint, and the task is rejected
both with `--continue` (“continuation spent”) and without it (“`--continue` required”). A permanently
unstartable task is worse than the retry storm the limit was introduced to prevent.

## Manual stop

`codex-bridge stop <run>` closes a hung run: it kills the recorded pid with its entire process tree and
closes the directory as abandoned — `meta.json` with status `FAIL` and a list of what the run left in
the tree. A run with a completed verdict is untouched, and a nonexistent directory produces a clear
error. Killing reuses the same function as the deadline: knowledge of `cmd.exe` and its grandchild on
Windows must not live in two places.

The indication that “the run has not responded yet” is the absence of `reply.txt`, not `meta.json`.
Artifact ordering writes `meta.json` before `reply.txt`, leaving a window where the verdict exists but
the run is not closed. If `meta.json` were used, a repeat arriving in this window would receive a refusal
instead of the response, leaving a hole in the “repeating is always safe” guarantee.

If the worker dies without `reply.txt` after an attachment, the attached invocation first trusts an
existing `meta.json`; if there is no verdict, it writes `FAIL` and notes that possible edits remain in
the tree.

## Heartbeat and `unlock`

The worker maintains a `heartbeat` file in the run directory: it updates the file as data arrives and on
a periodic timer while Codex is still running. The live-run hook considers only a record with
`state=running`, a live pid, and a heartbeat no older than five minutes fresh. A missing heartbeat
preserves compatibility with old runs and counts as live; the file is evidence of movement, not a
verdict.

A hung run is now visible separately: the pid remains alive and `status.json` remains `running`, but the
heartbeat modification time exceeds five minutes. Such a run cannot be closed through `unlock`: the
worker still owns its `meta.json`. `codex-bridge stop <run>` kills the process tree first and then writes
the failure — the sole writer in the correct order.

`codex-bridge unlock` is the manual intermediate step between a targeted `stop` and the automatic
`markAbandoned()` check at the start of the next run (launcher step 5). With no argument, it checks only
the current repository; with a name, one project; `--all` explicitly traverses all storage. Only
`state=running` records with `dead` or `foreign` identity are closed; `alive` is never closed, and the
output names `codex-bridge stop <run>`. `unverified` remains in place with an explanation. For every
record, the report prints its age, silence duration, and identity verdict of
`alive` / `dead` / `foreign` / `unverified`. A second invocation changes nothing, and the command deletes
neither directories nor transport files.

The old name `codex-bridge sweep` is recognized as a rename and responds with a refusal suggesting
`codex-bridge unlock`; it is not treated as an unknown command.

Unlike `stop`, `unlock` does not snapshot the worktree, so the `abandoned_reason` of runs it closes has
no file list. This is deliberate: `stop` closes one named run and knows its repository, while traversing
all storage would run `git` in every repository at once, and the list would describe today's tree rather
than the work of a long-dead run. If a file list is needed, close the run through `stop` while it is fresh.

## Point of no return

In practical terms, the boundary comes after the detached worker starts successfully. Before it, the
launcher can refuse without invoking Codex. After it, the worker owns the run, starts `runCodex()`, and
must close the directory regardless of what happens to the calling shell. Repeating the same command
after this point is safe and starts nothing — it attaches to the active run. The dangerous case is a
repeat with a changed job label: that is a second paid run in the same tree.

The external invocation itself starts in the worker at `runCodex()`. A created directory therefore does
not prove quota use: early failures after step 10 also leave `status.json` and `meta.json`. Such
directories receive `aborted_pre_start` precisely so that “a directory exists” is not read as “a task
pass occurred.”

## Worker sequence

1. The worker reads `worker.json`, takes `repo`, `agent`, `args`, `is_git_repo`, and `budget_minutes`,
   and registers the current directory with the crash handler.
2. `runCodex()` receives the full `task.md` through stdin. The run uses `--json`, so stdout is a JSONL
   event stream written to `events.jsonl`, while stderr goes to `stderr.log`; each file has its own
   256 MiB limit, and exceeding it truncates the file rather than killing the run. `events.jsonl` is
   truncated on a line boundary: half a JSON line is not parsed, and the reader must skip unreadable
   lines rather than fail. They are separated at the “protocol versus everything else” boundary: the
   shared human-readable stream included contents of files read by the run, and quoting someone else's
   error colored the run `LIMIT` (see `verdict.md`). `stderr.log` is always created, even when stderr is
   silent. If either file cannot be written (no permission, disk full), the runner stops the Codex
   process tree and closes the run as a failure: continuing silently would leave the CLI consuming
   quota without an observer.
   At the same time, the time limit from `budget_minutes` starts (`scout` 15, `build` 25, `review` 20 —
   the `budgets` key in `run-config.json`). When it expires, Codex is killed together with its full
   process tree, the killing is recorded as `stopped_on_deadline` in `status.json`, and the worker closes
   the directory with a normal verdict. What Codex has already said survives because it is streamed to
   disk rather than accumulated in memory.
3. Immediately after `runCodex()` returns, the worker appends `stopped_on_deadline` and `elapsed_ms` to
   `status.json` — before `collect()` computes the verdict. The log line remains for people, but the
   verdict uses these fields: `status.json` is outside the repository covered by `workspace-write`, so
   Codex cannot forge it.
4. After Codex finishes, build writes `head-after.txt`, `branch-after.txt`, `git-after.txt`,
   `state-after.txt`, `diff.stat`, and `flags.txt`, in that order.
5. For scout and build, the worker reads the structured result and, if `report_markdown` is present,
   writes `report.md`. Review leaves its report in `review.json`.
6. `collect()` reads the artifacts, computes the verdict, and writes `meta.json`.
7. After `meta.json`, the same `collect()` updates `status.json` to `state=finished`.
8. `emitReply()` creates `reply.txt`. This is the final required file: its presence means that
   `meta.json` and the final state are already on disk.
9. The worker exits with the code corresponding to the verdict.

## Crashes and abandoned runs

The crash handler lives in `run-codex.mjs` and applies to both halves. If the directory is already known,
it appends the error to `stderr.log` — the file specifically for events outside the CLI protocol —
creates `meta.json`, closes `status.json` as `failed`, and forms the response. The worker writes the
response to a file; the launcher writes it to stdout.

If the process dies before the handler runs, the next launcher checks the previous `status.json`. A dead
pid without `meta.json` becomes `abandoned` with `tree_after=false`; a dead pid with an existing
`meta.json` is recovered as `finished`.
