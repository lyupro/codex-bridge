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

Repeats select the anchor first, excluding automatic children from ordinary and manual-grant
matching, then follow at most one recorded automatic successor after the anchor's reply is known.
A started successor is introduced by `CONTINUED=<childDir> from=<anchor run name>` and a transition
notice; attach then answers or waits for the child and returns the child's exit code.
Repair lines after a cached non-OK reply name the last started run in the chain.

## First failure point: the orchestrator gate

Before the launcher starts, Claude Code invokes the `PreToolUse` hook `order-gate.mjs` on every attempt
to call a dispatcher. The gate reads the job text from `tool_input.prompt` and checks it against the
order schema in `src/home/lib/order-schema.mjs`: the call is exactly one `task file: <absolute path>` line,
and the header of that file must carry `order id:` (and full `scope:` for `codex-build`, or `phase:` for
`codex-advisor`). A missing value or obvious placeholder (`TODO`,
`<label>`, and so on) is rejected here, before either the subagent or Codex starts and before quota is
spent. A real label and scope allow the call to continue.

This is a producer-side check: the agent prompt also receives this list from the same table during
installation, but the gate protects the caller before control passes to the dispatcher. Only an `allow`
response begins the launcher sequence below.

## Launcher sequence

Order matters: early refusals must happen before Codex is invoked, and the worker must receive the
complete job before detaching from the launcher.

1. `loadRunEnv()` reads the host's `config.json` — resolved by `brand-home.mjs` from
   `CODEX_BRIDGE_HOME` or `~/.lyupro/.codex-bridge/`, never from the package directory — and fixes
   the environment flags. A configuration error ends the command without creating a run directory.
2. `parseArgs()` validates the CLI: `--agent` and `--task-file` are mandatory, and `--no-wait` is
   the only optional flag. Every other flag is a free refusal. A flag name in place of a required
   value counts as a missing value. The task-file path must be absolute and use forward slashes;
   `$`, doubled backslashes (`\\`) and a final backslash (`\`) are refused because the shell would
   rewrite them inside the command's double quotes.
3. Dispatchers always pass `--task-file`; the launcher reads it and rejects an empty task.
   A direct runner call may instead pipe the task on stdin, which requires a `repository:` header.
   It parses the header and validates the order: `order id:` for all agents, `scope:` for build,
   and `phase:` (`scope` or `advise`) for advisor are required. The orchestrator supplies the job
   label and scout subquestions under `## Questions` in the task body; the runner does not invent
   them and will not start without them. Optional `effort:` is checked against the Codex set
   (`none|low|medium|high|xhigh|max`) before invocation, not from an API response. An undeclared
   phase (or a missing required phase) is refused before the run folder exists; single-phase roles
   use `default` and do not accept `phase:`. Advisor `phase: advise` requires a `continue:` header
   grant, or a `retry:` grant for a failed advise pass. The Plan_80 E13 launch layer also supports
   a `resume:` grant for that failed pass; the public header label is accepted for scout, review and advisor.
   Malformed or misplaced header entries are
   refused before creating a run folder or spending quota; the producer hook applies the same
   check. Before proceeding, it also rejects a biased or
   malformed advisor task: `## Options` must contain at least two distinct `- option-id: description`
   choices without preference markers, and `## Paths` must contain at least one list path. A build task
   must contain exactly one valid `advice:` line in the header: `mechanical`, `revert`, `docs-only`, `test-only`, or
   an absolute path to an existing advisor run directory whose `meta.json` says agent `codex-advisor`,
   phase `advise` and status `OK` — a scope pass or a failed advice authorizes nothing.
   These task-contract refusals happen before the run folder exists and spend no quota.
4. `src/home/lib/runner/order-repository.mjs` resolves the repository to the git working-tree root
   that owns the task file, resolving a symlinked task file first. Ignored and untracked task files
   count, linked worktrees are distinct, and inherited `GIT_*` variables are ignored. Neither the
   dispatcher shell's cwd nor the hook's cwd chooses the target.
   Optional header `repository:` must name an absolute existing directory under the unchanged
   OW-061 rules; its git root must be that same worktree, so a subdirectory is allowed. A disagreement
   is a free refusal under rule `repository-source`, violation `mismatch`, naming both roots.
   A task file outside git or a task piped on stdin requires `repository:`; omission is the free
   refusal `label-required`. A non-git directory named by the label is accepted as is. A git discovery
   error is refused as `discovery-failed`, never treated as outside git.
   Grants (`continue:`, `retry:`, `resume:`) keep the order in its repository: a named run recorded for
   another repository is refused before attach as `grant-mismatch`. Resume and automatic recovery
   refuse frozen inputs whose `worker.json#repo` differs from `status.json#repo`: both answer
   `inputs-unusable` with the reason `repo-mismatch`.
   The PreToolUse order gate applies the same resolver before its grant pass, reads owner history
   from the resolved repository, and denies a recognized call whose task file cannot be read.
   <!-- service-folders:begin -->
   Immediately afterward, `validateScope()` checks scope patterns against repository contents and
   rejects a pattern that cannot match: an absolute or drive path, backslashes, `..`, a pattern inside
   a service directory (`.git/`, `.claude/`, `.codex/`, `.omx/`, `.omc/`, `node_modules/` — the verdict
   fails every change there whatever the scope says, so such a run could only end in FAIL), a pattern
   that can only name a directory (trailing slash, a directory that exists on disk, or a glob-free last
   segment without an extension), or a pattern that found nothing. This check runs for all agents and
   before creating the run directory; paths from `scope new:` (only for `codex-build`) are exempt from
   the requirement to exist — and only from that one, because the exemption is what let a bare directory
   through on 2026-09-19 and failed a finished run for the files it created inside it. The repository root
   is needed before validation, which is why this check belongs here rather than in `parseArgs()`.
   <!-- service-folders:end -->
5. Immediately after resolving the project run folder, the launcher takes one claim for that run
   store and the exact, case-sensitive order id. The store is identified by `dev:ino`, so path aliases
   share the claim. `kernel-lock.mjs` supplies the same primitive as the install/update lifecycle lock:
   a named pipe on Windows, an abstract socket on Linux, and no kernel lock on other platforms. The
   kernel releases the lock when its holder dies. The claim must come before `markAbandoned()`: a
   contender must not close a run whose worker is admitting itself. On 2026-09-24 two launchers of one
   order started 2.8 seconds apart and both ran and billed (Plan_60 D4).
   A waiter waits up to 60 seconds; if the claim stays busy, startup refuses with exit 1, naming the
   holder's answer (or saying it did not answer), with no run folder, no Codex launch and no quota spent.
   The answer diagnoses contention; it does not authorize a launch. Repeat the same command later.
   The claim is held through the pass gate, availability check, sandbox probe, preflight, retention,
   `makeRunDir()`, both `status.json` writes and the worker spawn. It is released in the launcher's
   `finally`, including on refusals; `attach.mjs` releases it through `beforeWait` before a live reply wait.
   On platforms without a kernel lock, `unclaimedRaceRefusal()` re-reads the chain just before
   registration, after retention. If another launch of this exact order appeared during preparation,
   it refuses with exit 1, no run folder and no quota spent; this narrows the race but is not a lock.
6. `markAbandoned()` closes earlier directories with `state=running` if their pid is already dead. Such
   a directory receives not only a marker but also a verdict: `meta.json` with status `FAIL` and a reason
   listing the files by which the current tree differs from that run's `state-before.txt`. The tree
   snapshot is passed as an argument — `meta/` intentionally makes no git calls. The list is honest but
   does not prove authorship: the comparison happens at the start of a later run, so it may include
   someone else's work, and the reason says so. The directory remains in `abandoned` state; otherwise
   the detached HEAD protection would stop seeing it.
7. `abandonedBranchDrift()` checks whether an abandoned run left the repository in detached HEAD. If it
   did, startup is rejected for all three modes, prints `git checkout <branch>`, and does not execute it.
   A branch-name difference is not a refusal: switching branches is normal operator work. The block
   clears itself as soon as the repository is back on a branch.
8. If `slug:` is absent from the header, the runner takes it from the mandatory job label and applies the sanitizer
   `[^A-Za-z0-9._-]+` → `-`; a result with no letters or digits is rejected before creating a directory.
   Then `chainRuns()` finds runs from the same repository by three signals: the same `slug`, the same
   header-free task-body fingerprint, or the same job label. A matching chain without a `continue:` or
   `retry:` (or, after activation, `resume:`) header grant stops startup
   before a new directory is created. Old-contract directories with a generic slug such as `build` are
   not lost: the saved job label or fingerprint finds them. Only runs that had a Codex session count:
   a directory with `state=aborted_pre_start` (and its old-contract equivalent) is excluded — it spent
   no quota and contains nothing to continue. The chain itself remains complete: it is the audit view,
   and the rejected run remains visible in it. An `advise` continuation is additionally refused before
   folder creation unless the named run's `meta.json` records `agent: codex-advisor`, `phase: scope`,
   and `status: OK`; an `advise` retry or resume carries the original `OK` scope instead.
   Plan_80 E18's third pre-start branch also excludes an `abandoned` automatic attempt-2 child with
   a matching parent marker, no `events.jsonl` (even empty) or `heartbeat`, and readable zero-evidence
   `meta.json`, so it cannot remain the chain end and block a manual `resume:` of its parent.
   `recovery-successor.mjs` is the only reader of the parent-to-child `recovery` relationship;
   it validates the recorded pointer and identity without inferring a child from folder order or names.
   Resume checks `resume-grant-usable` (last run, same order, finished non-OK, dead worker,
   eligible stop facts and a readable thread that has not advanced since the stop) and
   `resume-pass-identity` (same agent and phase). Unreadable or missing frozen task, schema,
   role files or worker profile refuse as `resume-grant-usable` with `inputs-unusable`.
   These checks precede folder creation and spend no quota; writers cannot resume.
9. First, `codexAvailabilityRefusal()` (`runner/preflight.mjs`, built on `runner/codex-availability.mjs`)
   looks `codex` up on PATH (once more after ~1 s on a miss) and asks `codex login status` (10-second
   deadline each, through `spawnCaptured()`). The measured `Not logged in` answer produces an `UNAVAILABLE`
   block on stdout, exit 5, no folder, no quota. A second PATH miss produces the free
   `Codex CLI readiness unconfirmed:` refusal, exit 1: a miss proves only "not found right now", as during
   the npm update of the CLI on 2026-10-10 (Plan_78 D5). Any other unclear probe produces the ordinary
   `Codex CLI unavailable:` refusal, exit 1. It runs before the sandbox probe because that probe can spend
   quota, and after attach and the repeat refusal so a live same-order run is still joined first
   (Plan_60 D2).

   `probeSandbox()` (`runner/sandbox-probe.mjs`) asks the host's Codex sandbox to run `echo` with the
   role's own sandbox flags, for every agent. Windows and Linux are judged — each only after both a dead
   and a live sandbox were observed on it; on macOS the result is `skipped`. The sandbox counts as dead
   only on double evidence: no marker with the role's flags, no marker in the flag-free control form,
   neither attempt exited with code 2 (an argument error), and `codex --version` still answers; a marker
   printed with a nonzero exit is `inconclusive`, since the marker proves a process started. A dead
   sandbox refuses the run right here with the probe's stderr and the operator's check command — on
   Linux also the official AppArmor repair, because there a dead sandbox is the ordinary state of a fresh
   Ubuntu 23.10+ server rather than an accident: no directory is created, retention does not run, no
   quota is spent. Every other outcome lets the run continue, including `inconclusive` — a timeout, a
   spawn error, rejected arguments, or flags this Codex version no longer accepts — and the whole result
   is written to `status.json#sandbox_probe` in step 11. Why this exists: on 2026-09-16 an unclean
   Windows shutdown corrupted the sandbox helper's state file, and every run started on a dead sandbox,
   spent quota and executed no command.
   Each attempt has a 30-second deadline and runs through `spawnCaptured()` (`runner/codex-cmd.mjs`), not
   `spawnSync`: on Windows the spawned process is `cmd.exe`, and a synchronous timeout killed only that
   shell while Codex kept running as its orphan — the 2026-07-31 class `stopCodex()` exists for. On the
   deadline the whole tree is stopped, a grandchild still holding the pipes gets two seconds after exit,
   and a process that never reports its exit gets five seconds after the stop, so the probe always
   settles.
   Only then comes the pre-flight pass (`runner/preflight.mjs`): for build, a live writing run in the
   same repository. The order matters: the probe takes
   seconds, and between the busy check and this run registering itself in step 11 nothing slow may run,
   or a second writer can enter the same tree unseen (review of 2026-09-17). A busy build therefore
   waits for the probe before it is refused. The refusal leaves the worktree untouched and exits 1 —
   the order was correct, the host or the tree was not — because on 2026-09-19 a busy refusal created
   its folder first, and inside `~/.claude`, where run folders live in the worktree, the live writer's
   witness spent every tool call demanding the orchestrator revert a directory the tool itself had
   created. The module is given no run directory at all, so a check added there cannot leave one.
10. A unique `<date_time>_<slug>` directory is created; on a name collision, `-2`, `-3`, and so on is
    appended.
11. The first artifact written is `status.json` with `state=running` and the launcher pid. Stdout then
    receives the line `RUN=<directory> order-id=<id>`. The id travels with the folder because a
    reply naming a run cannot otherwise be checked against the order that was placed.
12. An argument `cmd.exe` cannot carry, or a worker that fails to spawn, is closed through `meta.json`
    and `status.json` with status `FAIL` and state `aborted_pre_start`; no paid call has occurred. These
    two are the only launcher refusals left after registration: by then the tree snapshot and the worker order
    are already in the folder, so the folder can explain itself. The separate state is not cosmetic: it
    lets the next startup distinguish an empty directory from a run backed by spent quota. A busy tree
    and an unavailable CLI are refused earlier, in step 9, and leave nothing behind.
13. For review, the diff area selected by header `changeset:` (default `uncommitted`) is computed and
    written to `scope.txt`. For scout, subquestions parsed from `## Questions` in the task body are
    written to `questions.json` in the same order (`Q1..Qn`); the verdict reads this saved list rather
    than parsing the assembled task again. For build, header `scope:` patterns are written to `scope.txt`.
14. `env.json` is written, followed by `task.md` and `schema.json`. `schema.json` is not only the Codex
    response format: it tells the verdict whether the run was required to declare an outcome (`outcome`
    in `required`), so an old directory is judged by the contract of its own day — see
    [verdict.md](verdict.md).
    A resume skips the current review scope, questions, advisor task, assembled task and schema.
    It copies the named run's frozen `task-original.md` (or its original `task.md`), `schema.json`
    and role files (`questions.json`, `advisor-task.json` or `scope.txt`) without regenerating them.
    Its `task.md` is the package's continuation prompt for the named run's situation kind;
    `env.json` still records this launch's environment.
15. For build, `head-before.txt`, `branch-before.txt`, `git-before.txt`, and `state-before.txt` are
    captured. The launcher also copies start-dirty tracked and untracked files into `flags-baseline/`
    and writes `flags-baseline.json` before the run starts, so earlier uncommitted work is not
    attributed to this run. An empty `branch-before.txt` means detached HEAD, not missing data.
16. argv for `codex exec` is assembled; an argument unsafe for `cmd.exe` produces an artifacted `FAIL`
    before Codex is invoked.
    A resume uses `codex exec resume <thread>` with the frozen worker profile and
    `-c sandbox_mode=read-only`, without `--sandbox` or `-C`; process cwd is the repository.
    The same unsafe-argument refusal applies. Its budget is the full phase budget, and its
    silence policy is resolved exactly as for an ordinary launch.
17. `worker.json` is written — the complete job for the second half.
18. Detachment point: the launcher creates a detached worker with `stdio: ignore`, calls `unref()`, and
    updates `status.json`, replacing the active `pid` with the worker pid and adding `runner_pid`.
19. The launcher prints a `STARTED` line with the mode, slug, job label, and worker pid, followed by
    instructions for returning for the verdict, then exits with code `0`. It no longer waits here.

## Attaching by job label

`task_hash` fingerprints the header-free task body, normalizing whitespace and case.
`status.json#task_hash_scheme` is `2` for this scheme; a missing field identifies an earlier scheme.
Changing only header metadata does not change this identity.

A repeated invocation with the same label does not create a second run. The check occurs before
directory creation, immediately after finding the chain and before the missing-grant refusal
(step 8):

- **A run with this label already has `reply.txt`** — the verdict is printed from disk; the repeat
  responds rather than refusing. `--no-wait` does not change this branch or its existing verdict exit
  code.
- **The label already belongs to a run whose task-body hash differs** — the invocation refuses with exit
  code `2`, naming the folder that owns the label, its slug and start time, and the two remedies: a
  new `order id:`, or a `continue:`/`retry:` header grant. If the owner lacks
  `task_hash_scheme` and its hash differs, the refusal explains that the owner predates the task
  header and its task cannot be compared, points to the saved answer in that folder with
  `codex-bridge read "<directory>"`, and gives the same remedies. Nothing is printed from the other
  run, no folder is created and no quota is spent. Checked before every branch below, and skipped
  with a `continue:` or `retry:` header grant and whenever
  either task hash is unknown, so runs older than the `task_hash` field keep attaching as they did.
- **There is no `reply.txt`, and the pid is alive** — the invocation prints
  `ATTACH=<directory> order-id=<id> started=<time>`, waits for `reply.txt`, and prints it. The next line states
  that the run is already in progress, no new work was started, and this invocation is waiting for its
  verdict. When `reply.txt` already exists, the next line instead says this is the answer from the
  previous run and no new work was started. Codex is not invoked and quota is not spent. An interrupted
  repeat damages nothing: the next invocation attaches to the same run. Before waiting, the attaching
  invocation gives up the claim through `beforeWait`, because the worker needs it to admit itself.
- **There is no `reply.txt`, the pid is alive, and `--no-wait` was passed** — the invocation prints
  `ATTACH=<directory> order-id=<id> started=<time>`, reports how long the run has been in progress, and returns exit
  code `4` immediately. This is a call outcome, not a run status; a later ordinary repeat still waits
  for and returns the saved verdict.
- **No run exists for this order label and `--no-wait` was passed** — the invocation reports that no
  run exists and returns exit code `4`. It never creates a run directory or invokes Codex.
- **There is no `reply.txt`, and the pid is dead** — this is an abandoned run with nothing to attach to;
  the earlier path applies (`markAbandoned()` has already marked the directory, then the missing-grant
  refusal takes effect).
- **A `continue:`, `retry:` or `resume:` grant is present** — the invocation attaches only to a run of this order label whose
  `status.json#continued_from` names the same run as the header's `continue:` grant, or whose
  `status.json#retry_of` names the same run as its `retry:` grant, or whose
  `status.json#resumed_from` names the same run as its `resume:` grant, and it does so BEFORE the
  grant is checked: that run is what an identical earlier continuation command started, and by now the
  grant is spent. Live, saved and dead cases are then handled exactly as above. No such run — a new pass
  starts, subject to the authorization below. On 2026-09-23 a dispatcher repeating its continuation to
  collect the verdict was refused as a reused grant while its advise run was working — every
  continuation was unable to return its verdict to chat.

When attach returns a saved non-OK reply, it appends ready grant lines, including a `retry:` line
when the failed last run has an order id. A CAPACITY last run gets only capacity guidance,
with no ready `continue:` or `retry:` line.

## Continuation authorization

The gate always parses the task-file header for authorization: a `continue:` grant authorizes the
next pass, and a `retry:` grant repeats a failed pass. The dispatcher never adds anything to the
command. The header consists of consecutive lowercase `label: value` lines in any order at the very
start of the task. The registry in `src/home/lib/order-schema.mjs` requires `order id:` for all agents,
`scope:` for build only and `phase:` for advisor only. Optional `scope new:` is build-only;
`changeset:` is review-only; `slug:`, `effort:` and `repository:` apply to all agents. Build also
requires `advice:`. Either grant is conditional for all agents. One initial BOM is ignored;
no blank line may precede the header. The first blank or other line ends it; separate the header
from the task body with a blank line. A build continuation has this form:

```text
order id: plan-14-build
scope: src/auth/**,tests/auth/**
continue: 2026-08-05_092913_plan14-build — LIMIT at step 3, tests unwritten
advice: mechanical

Complete step 3 and write the remaining tests.
```

```bash
codex-bridge run --agent codex-build --task-file "/abs/path/to/follow-up.md"
```

The grant names the run after which execution continues and gives the reason. Each value must be
non-empty and single-line; duplicate labels and both grants together are free refusals. After
`continue:` or `retry:` there must be a bare folder name (`[A-Za-z0-9._-]+`, excluding `.` and `..`),
`—`, and a non-placeholder reason. The line form constitutes authorization, not the existence of
the named directory. A typo in the name is still authorization in the wrong form for the
directory check: the runner does not silently replace it with the correct name. Mentioning `continue:`
in ordinary prose is not authorization. Below the header, a known label, decorated or not, followed
by a bare folder name with or without a reason, or by an advice value, is refused with its line
number and repair: move it into the header with the exact lowercase spelling, or quote an example
with `>` or reword it inside a sentence. Code fences do not exempt such metadata. Other prose that
merely starts with a label stays task text. The same rules cover task files, and
`order-gate.mjs` applies the same refusal on the producer side.

All refusals are free:

- authorization is absent, or its value is a placeholder (`<...>`, `TODO`) — refusal;
- the named directory does not exist in the project's runs directory — refusal with the same hints;
- the named run is not the last in the chain — refusal.

If a grant cannot authorize a new pass, the refusal names the exact directory of this task's
last run, its status and reason, and prints a ready-to-use authorization line. A failed last run with
an order id also gets a ready `retry:` line, except that a CAPACITY last run gets only capacity
guidance and no ready `continue:` or `retry:` line. If the directory is absent, all three hints are still
provided; the entered name is not substituted.

The last rule makes authorization single-use: continuation appends a later run to the chain, so the same
line stops matching by itself — without a counter or new state. The named run is recorded in
`status.json` as `continued_from`. It is not a validation input for the grant; it is the key by which a
repeated continuation command finds the run it already started (see the attach rules above).

Without a grant line, a normal repeat can still safely attach to the previous run; a grant authorizes
a new pass or attaches to the pass it already started. Therefore the `PreToolUse` job-label gate does
not require a grant for every call: legitimate first attempts and ordinary attaches need none.
The decision to continue belongs to the orchestrator. The 2026-08-05 incident caused this rule: after
receiving an honest `FAIL`, the dispatcher assigned itself a second attempt using 75,691 tokens of
someone else's quota and invented work the job had not requested. The
`2026-08-10_220535_plan25-2-install-table-two-roots` incident showed that without this ordering an old
response could look like the verdict for a new job.

## Continuation limit

An advisor `scope` phase is never continued: header `phase: scope` with a `continue:` grant is
refused before start, because
continuing a failed scope spent the order's single continuation and left its `advise` phase unreachable
(2026-09-30). A failed scope can be repeated with a `retry:` header grant, or under a new
order id; `advise` then continues that order.

A limit applies on top of continuation authorization: a `continue:` grant in the header is
permitted once per job label and only after a run with a recorded verdict:

- no runs with this label — continuation is allowed;
- one run with a verdict — allowed;
- one run without a verdict — refusal: the run may still be editing the tree, and a repeat without
  a grant will attach to it;
- two or more — refusal naming the spent runs; another attempt requires a new job label from the
  orchestrator.

Only runs with this label that are neither retries nor resumes count, not the entire chain.
Runs with `retry_of` or `resumed_from` spend no additional pass or continuation, even if a resume
ends `OK`. Scope plus advise still spend two passes; scout plus any number of resumes spend one.
The chain also links runs by slug and header-free task-body
fingerprint — catching a repeat that renamed itself — but applying the limit to the chain would break
the promised exit: a new label joins the same chain through the fingerprint, and the task is rejected
both with a grant (continuation already spent) and without one (a grant required). A permanently
unstartable task is worse than the retry storm the limit was introduced to prevent.

## Retry authorization

`retry: <failed run> — <reason>` in the header repeats a `FAIL`, `LIMIT`, `UNAVAILABLE`,
or `CAPACITY` pass once under that grant. The named folder must exist and be the last run of the
chain, have a finished verdict and a worker proven dead, and match this call's order id, agent, and
phase. A missing verdict, a worker that may still be alive, or an `OK` outcome is a free refusal.
An advisor `advise` retry carries the original `OK` scope, rather than treating the failed advise
run as a scope result.

If the named CAPACITY run's own `retry_of` predecessor also ended CAPACITY,
rule `retry-grant-usable` refuses for free as `capacity-repeated`; repeating later requires
a new order id. A capacity retry starts fresh with the role's current model: wait or change it
with `/codex-bridge:model` first; a second CAPACITY of the same order goes to the next executor.

The new run records the named folder in `status.json#retry_of` and does not count as another
continuation of the order. Appending it spends the grant; repeating the identical retry command
attaches to that run instead of starting another one. Its reply includes
`Attempt: N of this pass — retry of <run>`. Refusals that encounter a failed last run with an order id
print a ready `retry:` line, and attach appends ready grant lines to a saved non-OK reply.
For a CAPACITY last run, both return only capacity guidance, with no ready `continue:` or `retry:` line.

## Resume authorization

Plan_80 E13 O6 supplies the launch and attach layer for `resume: <failed run> — <reason>`;
the public header label is accepted for scout, review and advisor. A resume continues the named failed run's
Codex thread with its frozen inputs. It must name the chain's last run of the same order, agent
and phase, with a finished non-OK verdict, a dead worker, eligible stop evidence and a readable
thread that has not advanced after the recorded stop. `resume-grant-usable` refuses violations;
`resume-pass-identity` refuses an agent or phase change. Missing, malformed or unreadable frozen
inputs refuse as `resume-grant-usable` / `inputs-unusable`, before a new folder or paid work.
Build writers cannot resume.
A CAPACITY run is not eligible: grant blocker `capacity` refuses it, since resume reuses the old model.

Under `resume:`, the task body is a plain note for the record, saved as written (surrounding blank lines trimmed) as `resume-note.md` in the new run folder and never read by the resumed run, which reuses the frozen questions, options, paths and verification of the named run.
Questions, Options, Paths and Verify headings in that body are refused before start; a changed task needs `retry:` or a new order id.

An advisor `advise` resume carries the original `OK` scope in `continued_from`, including through
multiple resumes, and never regenerates its advisor task from today's scope result. The new folder
records `status.json#resumed_from`, frozen `task-original.md`, `schema.json` and role files, the
package continuation prompt as `task.md`, the orchestrator's `resume-note.md`, and this launch's `env.json`. `worker.json` records the
frozen profile and `resume: { thread_id, resumed_from, sandbox_mode: 'read-only' }`; ordinary runs
record `resume: null`. The command is `codex exec resume <thread>` with `-c sandbox_mode=read-only`,
no `--sandbox` or `-C`, and cwd set to the repository. It receives the full phase budget and the
ordinary silence policy.

A resume spends no pass. Appending it makes the grant single-use for starting work; repeating
the same grant attaches by `status.json#resumed_from` before checking whether the grant is spent.
Resuming a failed advisor scope preserves the advise continuation; resuming advise does not grant
a third pass. A scout run followed by failed and successful resumes still has its continuation.

## Manual stop

`codex-bridge stop <run>` closes a hung run: it kills the recorded pid with its entire process tree and
closes the directory as abandoned — `meta.json` with status `FAIL` and a list of what the run left in
the tree. A run with a completed verdict is untouched, and a nonexistent directory produces a clear
error. Killing reuses the same function as the deadline: knowledge of `cmd.exe` and its grandchild on
Windows must not live in two places.
Stopping a parent with a recorded verdict names its valid automatic child and sends no signal.

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
`markAbandoned()` check at the start of the next run (launcher step 6). With no argument, it checks only
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

In practical terms, the boundary comes after the detached worker is admitted under the claim. Before
it, startup can refuse without invoking Codex. After it, the worker owns the run, starts `runCodex()`, and
must close the directory regardless of what happens to the calling shell. Repeating the same command
after this point is safe and starts nothing — it attaches to the active run. The dangerous case is a
repeat with a changed job label: that is a second paid run in the same tree.

The external invocation itself starts in the worker at `runCodex()`. A created directory therefore does
not prove quota use: early failures after step 11 also leave `status.json` and `meta.json`. Launcher
refusals receive `aborted_pre_start` precisely so that “a directory exists” is not read as “a task
pass occurred.”

## Worker sequence

1. The worker reads `worker.json`, takes `repo`, `agent`, `args`, `is_git_repo`, `budget_minutes`, `order_id`,
   `silence_policy.threshold_ms`, and `recovery_policy.watchdog.arming`,
   and registers the current directory with the crash handler.
2. Before Codex starts, `admitWorker()` takes the same project-store and exact-order claim, waiting up
   to 60 seconds. Admission requires `status.json#state` to be `running` and no `meta.json`. Under the
   claim, the worker records its own `pid`, `runner_pid` and start identity (`process_started_at`), then
   releases the claim in `finally` before `runCodex()`. A closed run makes the worker exit with code 1
   without Codex and without writing anything. A claim that stays busy produces `FAIL` with
   `run worker was not admitted: the order claim stayed busy`, naming the holder's answer; the worker
   exits with code 1, Codex was not started and quota was not spent.
3. `runCodex()` receives the full `task.md` through stdin. The run uses `--json`, so stdout is a JSONL
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
4. Immediately after `runCodex()` returns, the worker appends `stopped_on_deadline` and `elapsed_ms` to
   `status.json` — before `collect()` computes the verdict. The log line remains for people, but the
   verdict uses these fields: `status.json` is outside the repository covered by `workspace-write`, so
   Codex cannot forge it.
5. After Codex finishes, build writes `head-after.txt`, `branch-after.txt`, `git-after.txt`,
   `state-after.txt`, `diff.stat`, `flags.txt`, and `flags-coverage.txt`, in that order. Flags judge
   lines added since the start baseline; coverage gaps name files that could not be judged. The
   worker removes the `flags-baseline/` copies immediately after the scan, leaving the manifest.
6. For scout and build, the worker reads the structured result and, if `report_markdown` is present,
   writes `report.md`. Review leaves its report in `review.json`.
7. `collect()` reads the artifacts, computes the verdict, and writes `meta.json`.
8. After `meta.json`, the same `collect()` updates `status.json` to `state=finished`.
9. `emitReply()` creates `reply.txt`. This is the final required file: its presence means that
   `meta.json` and the final state are already on disk.
10. The worker exits with the code corresponding to the verdict.

Steps 3–8 form one `runPass`, shared by both attempts. After the parent's `collect()`,
Plan_80 E17/O5e adds this bounded path in the same worker process:

1. Unless recorded `meta.continuation_eligibility.automatic.allowed` is exactly `true`, publish
   the collected parent reply, commit its run record, and exit by its verdict as before.
2. Otherwise call `reserveRecoveryChild({ parentDir, meta })`. A refusal records only
   `status.json#recovery_refused: { reason, at }` (ISO timestamp), preserving `meta.json`,
   then follows the ordinary parent reply, commit and exit path.
3. A reservation writes the child folder and frozen order before the parent's
   `status.json#recovery: { child, reserved_at, automatic: true }` pointer. Only after that
   pointer is on disk, re-render the recorded parent reply, publish it and commit its run record.
   The child's `status.json#recovery` records `{ automatic: true, attempt: 2, parent, reserved_at }`.
4. Call `adoptRun(childDir, agent)` once to move the reply target, current run and crash identity together.
5. Admit the child under its saved `order_id`. Any refusal writes a pre-start failure with
   `automatic continuation was not admitted: <reason>` and `Codex was not started; quota was not spent`,
   publishes the child reply, commits its run record and exits `FAIL`. Its state is
   `aborted_pre_start`, so it cannot make a manual `resume:` of the parent fail `not-last` (A15).
6. If admitted, run the child pass using its frozen order, publish its reply, commit its run record,
   and exit by the child's verdict. There is no third attempt or loop: `resumed_from` blocks the
   child's eligibility with `recovery-attempt-spent`. The parent reply remains unchanged.

The package switch `AUTOMATIC_RECOVERY_ENABLED` remains `false`, so real runs currently follow
the ordinary single-attempt path.

### Silence watchdog

Plan_80 E25 permanently retires silence-based stopping for every role and phase:
Codex encrypts its reasoning, so long thinking and a stall look the same. The watchdog
only records (`shadow`) or is `off`; the runtime refuses `armed`. Arming is frozen at launch
in `worker.json#recovery_policy.watchdog.arming`, and the frozen
`silence_policy.threshold_ms` labels shadow diagnostics. Only Codex session-log activity
is used; two consecutive reads must confirm command-free silence at or above the threshold.
Stdout, heartbeat and file times are not activity signals. `shadow` records observations
and a confirmed diagnostic decision in `stop.watchdog`, and never stops Codex. A stalled
pass ends on its deadline and is continued with `resume:`. The first stop cause wins,
including an earlier deadline or exit. Polling stops on deadline, exit and settlement.
The runner ignores the watchdog's answer, and `check()` returns nothing, so no watchdog,
including an injected one, can stop Codex (Plan_80 E28).
The host brake `off` freezes arming to `off`, preserving the old behavior without polling;
older orders without these policy fields also use `off`. Reader failures record `fault`
and disable further reads without ending the run. The watchdog starts no continuation
and does not change verdict or reply logic.

## Crashes and abandoned runs

The crash handler lives in `run-codex.mjs` and applies to both halves. If the directory is already known,
it appends the error to `stderr.log` — the file specifically for events outside the CLI protocol —
and, when no verdict is recorded, creates `meta.json`, closes `status.json` as `failed`, and forms the
response. A crash after the verdict is recorded keeps `meta.json` and `status.json` byte-identical and
re-renders the recorded reply, appending `Runner crashed after the verdict was recorded: <error>` and
`Log: codex-bridge read <run>`. The recorded verdict also determines the exit code, preserving the stop
assessment and ready resume grant (Plan_80 E17, A14/A15). The worker writes the response to a file;
the launcher writes it to stdout.

If the process dies before the handler runs, the next launcher checks the previous `status.json`. A dead
pid without `meta.json` becomes `abandoned` with `tree_after=false`; a dead pid with an existing
`meta.json` is recovered as `finished`.

A launcher killed between spawning the worker and recording its pid frees the kernel claim. Whoever
claims it first decides the run's fate: a contender that closes the run as abandoned makes the late
worker exit without Codex and without writing anything; a worker that admits itself first records its
own identity, and the contender attaches to that live run instead of launching another paid one.
