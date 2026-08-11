# How the Verdict Is Computed

`write-meta.mjs` reads the artifacts and passes them to `resolveStatus()`. Checks run sequentially;
the first matching branch determines the status. The order is therefore part of the contract.

## `resolveStatus()` order

1. **The run was abandoned at startup.** `events.jsonl` exists but contains no events, and the adjacent
   `stderr.log` exists and is empty — Codex said nothing either through the protocol or outside it. This
   is `FAIL` with its own reason. The check comes first, where the empty-`raw.log` check previously stood:
   the branches below accuse the run of how it behaved, while a HEAD change during a run that never
   existed is someone else's commit. Both files are checked for **existence** before emptiness: a missing
   `stderr.log` is not silence but missing evidence, handled by check 5.
2. **A commit during build.** Different `head-before.txt` and `head-after.txt` values produce `FAIL`.
   This check ranks above `LIMIT` and result quality: moving history despite an explicit prohibition is
   a contract violation that the orchestrator must learn first.
3. **A branch change during build.** Immediately after the commit check and at the same rank: different
   `branch-before.txt` and `branch-after.txt` values produce `FAIL`, including when the commit did not
   move — otherwise entering detached HEAD on the same commit would pass silently. An empty value here
   means detached HEAD, while a missing file means no snapshot; only complete pairs are compared, and
   half a pair never accuses a run.
4. **The run was killed at its deadline.** The runner that killed Codex writes `stopped_on_deadline` to
   `status.json`; this is a fact, not log text. It produces `FAIL` with a reason naming the elapsed time.
   This check ranks above `LIMIT` because a killed run almost always arrives with an empty result and
   would otherwise fall into that branch — which is how the false `LIMIT` on 2026-08-05 arose. It ranks
   below the commit and branch prohibitions: a violated contract matters more than the cause of death.
5. **Transport artifacts contradict one another.** Two impossible combinations produce `FAIL`. First,
   `worker.json#args` contains `--json` but `events.jsonl` is absent from disk — the run promised an event
   stream and did not leave it, so evidence was lost after the run. Second, `status.json` has a
   `stopped_on_deadline` field but no adjacent `stderr.log` — the same invocation writes both. A run
   whose arguments do not contain `--json` is archival and is judged by the rules of its own day.
6. **A transport error in events.** An event with `type: "error"` or `turn.failed` produces `LIMIT` if it
   carries `status: 429` or an error type naming a limit, and otherwise `FAIL` with the event's reason.
   The check considers only a run with nothing to show (an empty result or nonzero exit): the CLI also
   prints an error event for an interrupted stream that it then survives, and coloring a run that
   completed its work would mirror the false `LIMIT`. `item.completed` is never a source — see
   “Transport and data.”
7. **The result is absent or unfilled.** `FAIL`, with the reason selected in this order: first the model's
   last complaint about the job content (`item.completed` with `item.type: "error"`), then a transport
   error from events, and only then `stderr.log`. The order follows from the live probe on 2026-08-05:
   a healthy run has execpolicy refusals in `stderr.log`, and the previous parser presented an arbitrary
   blocked call as the cause of failure. There is no separate quota search here: check 6 is the only
   source of `LIMIT`.
8. **Nonzero exit with a filled result.** This is `FAIL`. Having JSON does not cancel a process failure.
9. **Failed build verification.** `verify_passed === false` produces `FAIL` even if the changes and
   schema are correct. This check must come before scope and report matching: a failed mandatory command
   is already sufficient for failure.
10. **Declared build outcome.** The executor reports in the mandatory `outcome` field whether the
    requested work was completed: `fail` produces `FAIL` with the reason from `summary`. The check comes
    after verification and before scope: unfinished work matters more than where it was left, while a
    failed mandatory command remains the louder failure. Only runs whose own `schema.json` required the
    field are judged by it — see “Run age” below.
11. **Scout coverage.** Multiple extracted questions require separate answers, enough substantive text,
    and at least one evidence link for each question. For a single question, the overall `answer` is
    checked for substance.
12. **Build edits outside scope.** `environmentPaths` are subtracted from the tree delta first, then the
    remaining paths are compared with `scope.txt`. This check ranks above report matching: a report can
    name one allowed file while concealing several extra ones.
13. **Build report matches actual work.** `changes[].file` entries are first compared with the current
    run's delta. If there are no matches, service paths are rejected before examining the chain. The
    declared files are then searched in the accumulated diff from the chain's first `state-before.txt`
    through the current `state-after.txt`.
14. **Success.** A match only with accumulated work returns `OK` and `carried: true`; normal completion
    returns `OK` without a reason.

## Transport and data

`LIMIT` is the only verdict that tells the orchestrator not to retry, so it cannot be based on text the
run itself placed in the output. A run on 2026-08-05 received `LIMIT` because it grepped the repository
and printed to `raw.log` a line from the package's own test fixtures: the quoted markers were identical
to those in a real error.

The first attempt separated the streams: stderr in its own file, quota errors only there. A live probe
on 2026-08-05 (`2026-08-05_155023_plan15-deadline-probe`) disproved this — `codex exec` without flags
writes the entire human-readable log, including tool output, to stderr: 206,013 of 206,086 bytes went
there, and lines from source files read by the run appeared in `stderr.log`. This CLI does not divide
output at the “transport versus data” boundary.

The boundary was in the protocol rather than the streams. All three agents start with `--json`, and the
CLI prints a JSONL event stream: `thread.started`, `turn.started`, `item.completed`, `turn.completed`,
while failures are `type: "error"` and `turn.failed`. A transport failure here is **a field, not a
phrase**, and is structurally separate from what the model said.

- **`events.jsonl`** is the only source for the `LIMIT` verdict, usage, and session identifier.
- **`stderr.log`** is what the CLI says outside the protocol: panics, an unknown-flag refusal, and, as
  the live probe on 2026-08-05 showed, execpolicy refusals (`rejected: blocked by policy`) containing
  repository paths. It is **not normally empty** — the opposite promise lasted exactly until the first
  run under `--json`. This is why it comes last in the `FAIL` reason order: a line from it describes a
  blocked call that the run survived, not what killed it.
- `raw.log` no longer exists. Under `--json` it was a byte-for-byte copy of `events.jsonl`, yet the
  “run abandoned” verdict depended on it even though `usage.md` itself declares it removable. An artifact
  that may be deleted cannot support a verdict. A person reads a run with
  `codex-bridge read <run>`, which renders events on demand.

**`item.completed` is never a source of a transport verdict.** This event contains model text — exactly
where a line quoted from the repository appears. Restoring it as a basis would restore the defect to the
place from which it was removed.

The indication that a run was **required** to leave an event stream is the `--json` flag in its own
`worker.json#args`, just as `schema.json` indicates a declared outcome. The marker is the contract, so
“whether the run was required” and “what it was required to do” cannot silently diverge. A run with
`--json` and without `events.jsonl` is not an archive but corrupted evidence, and receives `FAIL`
(check 5); otherwise a lost file would silently restore the old behavior — the only way to undo the fix
from outside.

There is no longer any text search for quota errors in the package. It was removed completely rather
than retained “just in case”: while two lines containing `rate limit` remain, the entire defect class
remains.

Separately, consider what happens if a log file cannot be written at all (no permission, disk full).
The stream error arrives on the first write, and the runner must **stop Codex** there rather than crash:
without a handler, the event kills the worker, the crash handler closes the directory, and the CLI keeps
spending someone else's quota unobserved — the 2026-07-31 orphan with an extra step. The run dies with
its process, not instead of it.

The cost of the decision is explicit: if a future CLI version stops emitting quota refusal as an event,
the run will receive `FAIL` instead of `LIMIT`. This fails safely — `FAIL` calls for investigation,
whereas a false `LIMIT` abandons completed work.

## Declared outcome and run age

The runner does not know the job's intent, so the outcome is **declared**, not inferred. The run on
2026-08-04 (`2026-08-04_202959_build`) was asked to fix a function in a module absent from the checkout
and responded `OK — No code change was made`: all artifacts were valid and a clean tree is a legitimate
outcome for “check and fix if broken,” leaving no basis for objection.

`outcome` values are `done` — the requested work was completed — and `fail` — it was not completed for
any reason (an impossible job, a missing file, a scope prohibition, or lack of time). A `blocked` value
is deliberately not introduced until live-run statistics can distinguish it from `fail` by rule. It is
a string rather than a Boolean so the enum can expand without breaking the contract.

The indication that a run was **required** to declare an outcome is its own `schema.json`: if `required`
contains `outcome`, the run is judged by the declaration. There is deliberately no separate version
number next to the schema — the schema is the contract given to Codex, so “what the run was required to
answer” and “whether it was required” cannot silently diverge. A run without `schema.json`, or with a
schema without this field (an archive or replay of an old directory), retains the previous behavior; a
run with the field in its schema but no value in the response is `FAIL` with “result is unfilled.”

A declared `done` proves nothing: it only completes this check. Tree, scope, and report matching continue
in their previous order — the field adds a reason to turn red but cancels none of the existing checks.

Scout and review do not have this field: for scout, the outcome is expressed through subquestion
coverage; for review, through the verdict and findings. A second mandatory field beside them could
silently contradict them.

## Why environment is separated before scope

Snapshots record everything changed in the worktree, including writes from external tooling. Patterns
from `env.json.environmentPaths` divide paths into `work` and `environment`. Only `work` participates in
scope and report matching. `environment` is not hidden: the list goes to
`meta.json.environment_changes` and, when present, is printed as a separate response line.

Scope cannot allow a service directory. However, a path matching `environmentPaths` is excluded before
this check regardless of which process actually changed it. The list must therefore contain only paths
for which the operator is prepared to account as environment work; the audit remains in
`environment_changes`.

## Matching the report against the tree and chain

For tracked files, a snapshot contains counts of added and deleted lines; for untracked files, size.
This exposes a new edit to an already modified file even when its `git status` code does not change.

The chain for this comparison is assembled using all three signals: slug, task-text fingerprint, and job
label from `status.json`. A run that renamed itself and rewrote the text still finds its baseline, while
runs without these fields are linked by slug as before.

An empty `changes[]` with an empty delta is allowed — the runner does not know whether the job required
edits, and zero changes can be a legitimate outcome. The former cost of this rule (a run that did
nothing because the task was impossible received `OK`) is addressed not here but by the declared
outcome: check 10 turns red on the `outcome` field before report matching. The rule itself remains the
same — the runner does not invent the job's intent. An empty report with a nonempty delta, or a report
matching neither the current delta nor the chain's accumulated work, produces `FAIL` for “wrong work
was done.” Service paths are checked before chain lookup so an earlier run cannot legitimize work in
`.git/` or `.claude/`.

## Statuses and process codes

| Status | Meaning | Runner code |
| --- | --- | --- |
| `OK` | Artifacts confirm contract fulfillment. | `0` |
| `FAIL` | The contract, process, verification, or work match was violated. | `1` |
| `LIMIT` | There is no result, and the event stream contains a transport refusal caused by exhausted quota. | `3` |

`LIMIT` does not mean partial success. For build, the short response separately reports in a `Worktree:`
line whether unfinished changes remain in the tree — for both `LIMIT` and `FAIL`. “Work was not done”
does not mean “the tree is clean”: a run may write half a change and declare `fail`. If tree snapshots
are absent (the run was killed before `state-after.txt`), the line honestly says `unknown` rather than
“no changes”: making a claim from absent data is exactly the error for which `tree_after: false` exists
in `status.json`.
