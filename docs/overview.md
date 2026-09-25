# Codex Dispatchers

This directory contains the package for delegated Codex CLI runs from Claude Code. The dispatcher
passes the task to the runner and returns only the run path and a short status. The full
response, log, worktree snapshots, and the verdict computed from them remain in the artifacts.

## Which agent to choose

| Agent | Access | When to use |
| --- | --- | --- |
| `codex-scout` | `read-only` | Analyze code, find the cause of a failure, gather facts, or answer several technical questions without edits. |
| `codex-build` | `workspace-write` | Implement a change, fix a defect, add tests, or add documentation. Requires an explicit `--scope`. |
| `codex-review` | `read-only` | Get an independent second opinion on a diff after implementation. Checks for defects, not style. |
| `codex-advisor` | `read-only` | Assess whether the listed paths cover a design question, then recommend among unbiased options before implementation. |

### Hard dispatcher boundary

The dispatcher does not perform the order. Its only job is to start a run through
`codex-bridge run` and return its result. Using the package command is a permission contract, not
a style choice: it lets host permission rules match a stable command instead of an expanded
installation-specific path. If the command is missing, fails to start, exits without a
`RUN=`/`ATTACH=` line, or the run cannot start for any other reason, the dispatcher must immediately
return `FAIL — could not start the Codex run: <reason>` and stop.

The dispatcher itself is forbidden from reading code, writing files, or fixing tests in this
situation: otherwise Claude pays for exactly the work that delegation to Codex was meant to move
outside its quota. It must never claim that files were created without a run that actually took
place: no run means no result. `SubagentStop` additionally blocks a response without a run
directory, so this rule is enforced both in text and by an external guard.

`codex-bridge hook <name>` and `codex-bridge run` load the code installed in the brand home, never
the package copy beside the command. `codex-bridge hook --home` answers a JSON protocol line.
Install and update write the short command form only when the command on `PATH` answers that
protocol for this home; otherwise they register path form for every hook. Update also rewrites a
registration using the wrong form, even when it exists. A launcher failure exits 1 rather than 2.
This prevents a repeat of the 2026-09-24 `dev:install` incident, when hook names unknown to the
older global package were registered and every shell call on the machine was refused.

`codex-review` supports the `uncommitted`, `base:<branch>`, and `commit:<sha>` scopes through
`--changeset`. By default, it reviews uncommitted changes.

## Running

The orchestrator writes the task to a file and supplies its path with `--task-file`. Shipped agent
definitions must call `codex-bridge run`; exposing the internal runner path breaks host permission
matching and causes an approval prompt for every delegation. Direct stdin remains available for
manual use, but stdin and `--task-file` cannot be supplied together.

Reconnaissance:

```bash
codex-bridge run --agent codex-scout --repo . --slug auth-flow --order-id order-42 --effort medium --task-file /abs/path/to/task.md
```

One line, absolute path, no free text. The sub-questions live inside that file, under a `Questions`
heading, one Markdown list item each — a host stops applying a permission rule the moment an
argument carries prose with a metacharacter in it.

Implementation:

```bash
codex-bridge run --agent codex-build --repo . --slug auth-flow --order-id order-42 --scope "src/auth/**,tests/auth/**" --task-file /abs/path/to/task.md
```

The verification command lives in the task file too, on one line under a `Verify` heading. An
operator's real check command contained `&&`, which is exactly what unmatches the rule.

Reviewing uncommitted changes:

```bash
codex-bridge run --agent codex-review --repo . --slug auth-flow-review --order-id order-42-review --changeset uncommitted --task-file /abs/path/to/review-task.md
```

### Design advice before a build

`codex-advisor` runs in two phases. The 5-minute `scope` phase checks whether the supplied paths
cover the question and records missing paths and predicted risks. The 15-minute `advise` phase is
available only with `--continue` after an `OK` scope run for the same order; it can continue an
insufficient-but-valid scope result too. The task file has `## Question` for the design question,
`## Options` with at least two unbiased `- id: description` lines with unique ids and no preference
markers, and `## Paths` with repository-relative paths. Every `path:line` citation must point to
an existing line, and its path must be listed under `## Paths` or in phase 1's `missing_paths`.

The scope reply starts with `OK — scope: sufficient; continue this run with --phase advise` or
`OK — scope: insufficient; N paths named`, then includes `Missing:` when needed, `Predicted risks:`,
and `Report: ... · Log: ...`. An insufficient scope is still an `OK` run with `sufficient: false`,
not a `LIMIT`. The advise reply contains `OK — recommend <option_id>: <text>`, `Rejected:`,
`Counter:`, `Risks: <confirmed> confirmed · <refuted> refuted · open questions <count> · confidence
<level>`, and `Report: ... · Log: ...`.

```bash
codex-bridge run --agent codex-advisor --repo . --phase scope --slug architecture-check --order-id order-43 --task-file /abs/path/to/advisor-task.md
```

`--agent` and `--order-id` are required. `--repo` defaults to the current directory, `--slug` is
optional and defaults to the `order id`, `--effort` defaults to `medium`, and `--changeset` defaults to `uncommitted`.
The `--effort` value is passed to Codex as is; the runner checks only that it is a single word.
`--no-wait` checks an existing run immediately: it returns its ready reply normally, or exit code `4`
when the run is still in progress or no run exists. It never starts a new run and cannot be combined
with `--continue`.

The same sanitizer is applied to the `order id` and an explicit `slug`: characters outside
`A-Za-z0-9._-` are replaced with `-`. If no letter or digit remains in the name afterward, the
runner refuses before creating a directory: an empty name or a name consisting only of separators
and dots cannot be a safe directory name.

### Why `--scope` is required

For `codex-build`, `--scope` is required and contains comma-separated glob patterns relative to
the repository root. The runner refuses before creating a paid call if scope is empty.

Pattern format is checked before Codex starts for all agents that accept scope patterns. The
refusal is immediate and free if a pattern cannot match anything: an absolute path or drive path,
backslashes, a `..` segment, a pattern inside a service directory (`.git/`, `.claude/`, `.codex/`,
`.omx/`, `.omc/`, `node_modules/`, which no scope can authorise — the verdict fails every change
there), or a pattern that matches no file in the repository. The file list
comes from the repository itself: `git ls-files --cached --others --exclude-standard`, meaning
tracked plus new uncommitted files, excluding ignored files; a directory without git is traversed manually while
skipping `.git` and `node_modules`. Before scope validation moved ahead of execution, such a scope
was discovered only in the verdict—the 2026-08-09 run with an absolute path consumed 18 minutes of
someone else's quota and received `FAIL` for work it had completed.

A file that does not exist yet is declared separately: `--scope-new "src/new-module.mjs"`.
These paths enter scope alongside the others and are exempt only from the existence check; the
flag is accepted by `codex-build`, the only agent that creates files.

Every pattern, declared or new, has to be able to match a file: a scope is compared against file paths
and never against directories. A pattern that can only name a directory — a trailing slash, a name that
exists on disk as a directory, or a glob-free name whose last segment has no extension — is refused
before the run with the spelling that works (`muse/scripts/**`). The exemption for new paths was the
hole: `--scope-new muse/scripts` passed validation, then authorised one file that would never exist
while every file created inside the folder counted as a stray, and the 2026-09-19 run was failed after
ten minutes of finished work.

Scope is more than an instruction in the prompt. Before and after the run, the runner snapshots
the tree, computes the paths actually touched, and ends the run with `FAIL` if a path is not
covered by any pattern. Service directories `.git/`, `.claude/`, `.codex/`, `.omx/`, `.omc/`,
and `node_modules/` cannot be allowed through scope. Paths classified by configuration as
environment changes are excluded from this check and recorded separately in the report.

### Why `codex-build` declares an outcome

The `codex-build` response contains the required `outcome` field: `done` means the ordered work
was completed; `fail` means it was not completed for any reason. The runner does not know the
order's intent and therefore cannot distinguish “there was nothing to fix” from “the work could
not be done”: a 2026-08-04 run asked to fix a function in a missing module returned `OK` with an
empty tree and a green verification. A declared `fail` produces `FAIL` with the reason from
`summary`; a declared `done` proves nothing—the tree, scope, and report consistency are still
checked as before. Details and check order are in [verdict.md](verdict.md). `codex-scout` and
`codex-review` do not have this field: their outcome is expressed by subquestion coverage and a
verdict with findings. `codex-advisor` reports its phase-specific scope assessment or recommendation.

### Repeated runs and `--continue`

A chain is all runs of one repository that match by `slug`, task-text fingerprint, or order label.
If `--slug` is omitted, a new slug comes from the `order id`, so different orders do not inherit
the agent's generic name. If such a chain already exists, a new run without `--continue` does not
create a new directory or spend quota: an ordinary repeat attaches to the existing response or
wait. This protects against accidental repetition.

Directories created before this rule with a generic slug such as `build` are not renamed: the
chain still finds them by the stored order label or task fingerprint.

Add `--continue` only for the next pass on the same task, and only together with authorization in
the task text—the flag without authorization is rejected before quota is spent. The runner always
parses authorization from the text: if the line is present but the flag was lost along the way,
the result is a refusal before attachment, directory creation, and quota, not an old response
presented as the result of a new order:

```bash
codex-bridge run --agent codex-build --repo . --slug auth-flow --order-id order-42 --continue --scope "src/auth/**,tests/auth/**" --task-file /abs/path/to/follow-up.md
```

where `follow-up.md` contains a line with the run name and reason:

```
continue: 2026-08-05_092913_auth-flow — LIMIT at step 3, tests unwritten
```

Authorization is the line form: the `continue:` label, run directory name, `—`, and reason. Form
validation does not depend on whether the directory exists: the runner does not silently correct
a mistyped name, but refuses with the latest run's name, status, and reason, plus a ready-made line
for another attempt. Mentioning the word `continue:` in prose is not authorization. On a safe
`attach`, the first line is `ATTACH=<directory> order-id=<id> started=<time>`. For a saved reply, the
next line says that it printed the answer from the previous run and no new work was started. For a
live run, it says the run is already in progress, no new work was started, and this invocation is
waiting for its verdict.

An order id names one task. When the id already belongs to a run whose task text differs, the runner
refuses with exit code `2` before printing anything from that run: it names the folder that owns the
id, its slug and start time, and the two remedies — a new `--order-id`, or `--continue` if this
really is another pass of the same order. The refusal exists because on 2026-08-15 a run ordered
under the previous run's id was answered with that run's `OK`, its file list and its suite, over a
worktree where nothing had been done.

Authorization is single-use: it names the latest run in the chain, and continuation appends a
later one, so the same line will not work twice. Details and all refusals are in
[run-lifecycle.md](run-lifecycle.md).

When reconciling the builder's report, the runner considers accumulated changes from the state
before the chain's first run through the state after the current one. A continuation can therefore
honestly receive `OK` even if the needed edits were already made by an earlier pass. In `meta.json`,
this is marked by the `carried_from_earlier_run` field.

## Why an interrupted call does not lose the run

The runner consists of two processes:

- launcher checks arguments and the environment, creates the directory, and starts worker;
- detached worker invokes Codex, writes post-run snapshots, computes the verdict, and creates the response.

Launcher prints `RUN=<path> order-id=<id>` and waits for `reply.txt`, but interrupting it does not interrupt
worker during normal process termination or a timeout in the calling shell. Worker does not depend
on the dispatcher's stdout and closes the run with artifacts itself. Killing the entire process
tree can terminate both halves; the next run will mark the remaining unclosed run as `abandoned`.

## Artifacts

The root is set by the `CODEX_RUNS_ROOT` environment variable. An empty or missing value means
`~/.claude/codex-runs`. A single run directory has this form:

```text
<artifact root>/<project directory>/<date_time>_<slug>/
```

The project directory is named after the repository directory and marked by a `.project.json`
file containing that repository's full path. The marker exists because a directory name does not
identify a project: two different repositories both named `api` would write into one directory and
mix history—run chains, the parallel `codex-build` lock, and usage accounting would read each
other's runs as their own. A taken name sends the second repository to `api-2`, `api-3`.

Directories created before the marker existed are adopted by the `repo` field in their own runs'
`status.json`—no existing archive moves. If such a directory contains runs from two repositories,
it belongs to the one that ran there first; the second gets a suffixed name.

Paths are compared in normalized form: forward slashes, no trailing slash, and case-insensitive on
Windows. Symlinks and junctions are not resolved—`realpath` on Windows returns `\\?\` and UNC
forms, creating a new class of mismatches instead of solving the old one.

Main files:

| File | Purpose |
| --- | --- |
| `status.json` | Current process state and final status. Created first. |
| `task.md` | The verbatim task, computed constraints, and instructions for the selected agent. |
| `schema.json` | JSON Schema for the Codex response. |
| `worker.json` | Immutable order passed from launcher to worker. |
| `env.json` | Effective `hooks`, `plugins`, and `environmentPaths` settings for this run. |
| `events.jsonl` | Codex CLI event stream under `--json`. It—and only it—determines quota exhaustion, usage, and the session identifier. Human-readable through `codex-bridge read <run>`. |
| `stderr.log` | What the CLI said outside the protocol: panics, rejection of an unknown flag, execpolicy refusals. It is not normally empty—a live probe on 2026-08-05 found 488 bytes there in a healthy run. |
| `result.json` | Structured scout or build response. |
| `review.json` | Structured review response. |
| `report.md` | Detailed scout or build report extracted from JSON. |
| `meta.json` | Verdict, reason, token accounting, environment, and environment changes. |
| `reply.txt` | Short response to the dispatcher; worker writes it last. |

For scout, `questions.json` may appear; for review and build, `scope.txt`; build also creates
`head-*`, `git-*`, `state-*`, `diff.stat`, and `flags.txt` snapshots.

### Inspecting the run store

```bash
codex-bridge projects              # projects: runs, size, usage, live now, latest
codex-bridge projects codex-bridge # runs for one project: agent, verdict, tokens, size
codex-bridge projects --json       # same for a machine
codex-bridge read <run>             # progress of one run from its events
```

The “live now” column is computed by the same module used by the response guard and worktree lock—
the package's single answer to whether a run is currently active. A directory with unreadable
artifacts still gets a row: an inventory that hides broken data is useless precisely when it is
needed. A row without a verdict shows what closing the run would write—the judge's `abandoned` for a
dead or foreign process, `unverified` when its end cannot be proven—rather than the raw `running` a
dead run keeps in its `status.json` forever. A run without usage accounting does not zero the
project total—known values are counted.

### Cleaning the store

```bash
codex-bridge prune <project> <run>            # remove transport weight from one run
codex-bridge prune <project> <run> --purge    # remove the entire run directory
codex-bridge prune <project>                  # remove weight from all runs older than 30 days
codex-bridge prune <project> --purge          # remove the project directory
codex-bridge prune --all-projects             # remove weight everywhere; forbidden with --purge
```

Gentle cleanup removes **transport only**—`events.jsonl`, `stderr.log`, and the archived `raw.log`.
Accounting (`meta.json`), the report, the result, and tree snapshots remain: afterward the chain
of passes is still counted and the run's work can still be reviewed.

There are three barriers before deletion, and no flag bypasses any of them:

- **without `-f` / `--force`, nothing is deleted**—the command prints a plan and the line that
  executes it; plan and execution come from one function, so they cannot diverge;
- **a Yes/No confirmation for every deleting step** on top of the flag: the flag says “I know what
  I am doing,” the question says “right now and exactly this”;
- **no terminal means no deletion.** An agent runs commands without a TTY, and there is
  intentionally no bypass flag: that would be the very loophole being closed.

Age (`--older-than 30d`, `12h`, `2026-07-01`) is read **from the directory name**: a copied or
restored directory lies about its date in the file system, but its name does not. The 30-day
default belongs to gentle cleanup; `--purge` never adds an implicit age—`prune sbx2 --purge` means
that directory, now.

### Automatic cleanup

The `retention` key in `config.json` (a host file, untouched by updates):

```json
"retention": { "enabled": true, "days": 30 }
```

Before creating a new run directory, the runner removes transport from its runs older than the
specified period. **Automation can do exactly one thing—remove weight:** it has no code at all that
could delete `meta.json` or a directory. This is not a disabled setting but an absent capability;
it cannot be enabled by mistake. Live runs are never touched, and any cleanup failure is swallowed—
cleanup that can prevent a run is worse than a full disk.

Deletion is closed to agents by two barriers: the command refuses to work without a terminal, and
the `prune-guard.mjs` hook (`PreToolUse`, `Bash|PowerShell`) rejects the call before the deleting
process is even created. Your own terminal does not pass through the hook—`prune` works normally
there. The guard does not affect `git prune` or `npm prune`.

When triggered, automatic cleanup adds a line like
`Retention: freed 41.2 MB from 12 runs older than 30 days` to the dispatcher's short response —
every response of that run, whatever the verdict, including a runner failure. The
event is rare, and silence about it would cost more than the line: someone who does not understand
where the files went starts looking for a failure. Both `install` and `doctor` also warn about
enabled cleanup—an installer that silently introduces deleting behavior is a surprise, not a
convenience.

## Shell command permissions

Optional rules for `codex-bridge` commands can be enabled separately from installation:

```bash
node bin/codex-bridge.mjs permissions
node bin/codex-bridge.mjs permissions add
node bin/codex-bridge.mjs permissions remove
```

Without an argument, the command shows the ruleset state: `installed`, `partially installed`, or
`absent`. `add` adds exact allow and deny strings to the selected host's `settings.json` for both
CLI names, the `node bin/codex-bridge.mjs` path, Bash, and PowerShell, without touching unrelated
rules. `remove` removes only these strings from `allow`, `deny`, and `ask`, so a similar operator
string remains in place. The same `--scope` and `--host` options as for `install` are available;
`uninstall` removes these rules automatically.

## Environment configuration

`config.json` controls the delegated Codex environment. By default, `hooks` and `plugins` are
disabled: the runner passes `--disable hooks --disable plugins`. The switches can be viewed or
changed without manual editing:

```bash
node ~/.lyupro/.codex-bridge/lib/run-config.mjs
node ~/.lyupro/.codex-bridge/lib/run-config.mjs plugins on
node ~/.lyupro/.codex-bridge/lib/run-config.mjs hooks off
node ~/.lyupro/.codex-bridge/lib/run-config.mjs reset
```

`models` determines what each role runs on: an object with `scout`, `build`, `review`, and
`advisor` keys, each containing optional `model` and `effort`. Use
`codex-bridge model set <role> <model> [effort]` to configure it; the pair is checked against that
model's entry in the live catalogue before writing. `codex-bridge model unset <role>` returns the
role to whatever Codex chooses. A configured model reaches `codex exec` through the `-m` flag, while reasoning depth is chosen in
this order: the request's explicit `--effort`, then the role profile, then `medium`. Reading the
config and parsing `--effort` check only the form of the depth, never a list of values: that path
runs at the start of every delegated run and must not wait on the network, and Codex refuses an
unusable depth in its own words. An empty or missing profile means “Codex decides”; model
identifiers live only here and do not appear in code.

```json
{
  "models": {
    "build": { "model": "gpt-5.6-luna", "effort": "max" },
    "advisor": { "effort": "high" }
  }
}
```

The `config.json` file belongs to the host, not the package: the installer creates it once
with default values and never touches it again—not during `install --force`, `update`, or
`uninstall`. Configured profiles survive package updates.

The file a run reads is always the host one. `src/home/lib/brand-home.mjs` is the single resolver of
that path—`CODEX_BRIDGE_HOME` when set, otherwise `~/.lyupro/.codex-bridge/`—and both the CLI and the
runner ask it rather than deriving a path of their own. Until 2026-08-26 the runner built the path
from its own module directory and therefore read the copy shipped inside the package: a model and an
effort pinned in the host file never reached a single run, `env.json` recorded `"models": {}`, and
`doctor` kept confirming the setting because the CLI resolved the path correctly. Printing the state
(`node ~/.lyupro/.codex-bridge/lib/run-config.mjs`) now names the file together with where the path
came from, and `tests/run-config-reaches-the-run.test.mjs` fails if a configured profile stops
reaching the assembled Codex command line.

The same installer places restrictions for delegated runs: `codex-bridge.rules` goes into
`$CODEX_HOME/rules/` (by default `~/.codex/rules/`) and prohibits Codex commands that change the
repository's history, branches, and index. The operator's personal `default.rules` is not changed:
Codex reads the entire directory and applies the strictest matching decision. `codex-bridge doctor`
shows the file's state; `codex-bridge update` updates it.

The package's own files—hooks, runner, `config.json`, `conventions.md`, and the installation
record—live in the branded `~/.lyupro/.codex-bridge/` directory. Its location is overridden by
`CODEX_BRIDGE_HOME`, just as the Codex directory location is overridden by `CODEX_HOME`. The
variable exists primarily for tests and installation on an isolated host: the operator's home path
must not enter tests or configuration. `CODEX_BRIDGE_CWD` exists for the same reason and names the
directory `update` treats as the operator's own, so a test can place a checkout somewhere other
than the process it runs in; unset, the working directory is used. Exactly what Claude Code reads
only from its own directories remains in `~/.claude`: agent files, slash commands, and hook
registration in `settings.json`.

A delegated run does not create subagents: the runner passes `-c agents.enabled=false`, so
multi-agent tools are unavailable to the executor. Otherwise their edits would enter the tree
snapshot as work by the run itself, bypassing the scope check by which it is judged.

`budgets` sets run time limits in minutes by role: `scout` 15, `build` 25, `review` 20, and
`advisor` with `scope` 5 and `advise` 15. Single-phase roles accept a positive number; `advisor`
requires a phase map, and partial maps override only the named phases while retaining the defaults.
A bare number for `advisor` is refused. An empty field is a configuration error, not an absent
value. When the limit expires, worker kills Codex together with its entire process tree, records the kill in `status.json` through the `stopped_on_deadline` field (the verdict
judges the field written by the runner, not text to which Codex also writes), and closes the
directory with a normal verdict—`FAIL` with a deadline reason. The limit makes “for hours”
impossible by construction: its reference point is the project's longest legitimate run, which
took about twenty minutes.

```json
{
  "budgets": {
    "scout": 15,
    "build": 25,
    "review": 20,
    "advisor": { "scope": 5, "advise": 15 }
  }
}
```

`answerLanguage` is the language in which the run responds: `answer`, `report_markdown`, and text
fields in `result.json`. The default is `English`, regardless of the task language; the key is set
in `config.json` as a non-empty string, and an empty string is rejected when read. Without it,
the model chose the language—an English order came back in Russian, and one project's artifacts
ended up in two languages.

`environmentPaths` is a list of glob patterns for paths changed during a run by surrounding
tooling rather than Codex itself. Such changes do not participate in scope validation or report-to-
tree consistency checks, but remain visible in `meta.json.environment_changes` and the short
response. The list is edited directly in `config.json`; it is not a switch. Invalid JSON, an
unknown key, or a value of the wrong type stops the run without spending quota.

If the key is absent, five default patterns apply:

```json
[
  ".omc/**",
  ".claude/settings.local.json",
  "mcp-needs-auth-cache.json",
  "plugins/installed_plugins.json",
  "plugins/known_marketplaces.json"
]
```

An empty list explicitly means that no path is considered an environment change.

## Convention bundle

Project rules reached a run only when the orchestrator remembered to write “read CLAUDE.md” in
the task. If it forgot, the run worked without rules, and acceptance caught the same class of
violations for six consecutive passes. The bundle is now pasted into every run's `task.md` as a
separate `## Conventions` section, in two layers:

- `~/.lyupro/.codex-bridge/conventions.md`—the host-wide bundle. The file is **seeded**: the
  installer places it once and never touches it again, like `config.json`. The operator edits
  it without a package release.
- `.codex-conventions.md` at the repository root—an optional layer for project-specific rules.
  It travels with the project; if the file is absent, the layer is silently skipped.

If both are absent, the task has no section at all, and that is not an error. An empty (or
whitespace-only) layer file also produces no section: an empty bundle in the artifact would read
as “rules were provided and ignored.” `doctor` warns about an empty file with
`conventions: … (found but empty)`.

The text is explicitly **pasted**, not mentioned by a link: “read file X” is a hope, and the run
is free not to read it. This follows the same contract as enumerating required inputs. The side
effect is useful in its own right: a month later, `task.md` shows which rules governed the run.

The whole `CLAUDE.md` is intentionally not pasted—more than half of it concerns Telegram, backups,
releases, and UI, none of which relates to a Codex run: extra text in every task is not free and
dilutes what actually must be followed.

## Dispatcher gate

The gate is registered for `PreToolUse` on the shell tools and `SubagentHandback`, and for
`PostToolUse` and `PostToolUseFailure` on the shell tools. It acts only for the four dispatcher
agent types. The first line of the dispatcher's own transcript is the caller's order verbatim; the
gate derives exactly one `codex-bridge run …` command from it and permits only that command,
byte for byte. Every other tool call is refused with the command quoted in the refusal. Repeating
the command attaches to the same run, so a dispatcher never needs `--no-wait`. The runner's own
stdout replaces the handback. A handback without a runner call is refused once with the command,
then replaced by `FAIL — dispatcher did not delegate`; after a delivered handback every tool call,
including the runner command, is refused. This closes the 2026-09-17..24 TradeForge incident, when
a dispatcher returned its own words and a second writer started in the same tree.

## Response guard

`hooks/reply-guard.mjs` is the `SubagentStop` hook for the four dispatchers. After a handback it
stays silent; if the dispatcher stopped without one, it asks once for a handback. Its stop audit
checks that every tool call in the dispatcher transcript passed through the gate. A bypass raises
an alarm in the same turn (“do not trust this dispatcher answer”) and in the witness. The run is
looked up by the dispatcher's order id, not by the most recent run. It also checks that the response:

- contains `RUN=` with an existing directory;
- is not issued over a live or abandoned run without a verdict;
- **names every live `codex-build` run for this project, not only the one being quoted**;
- **reports a run whose `order_id` is the one the dispatcher was ordered**, read from the
  dispatcher's own transcript;
- is confirmed by `meta.json`;
- does not declare a status that contradicts `meta.json.status`.

The third check was added after 2026-08-05: the dispatcher returned the verdict of the first run
while leaving the second running in the background, and the orchestrator edited files in a tree
that another run was snapshotting before and after itself. The guard reads the project's entire
run directory, so omission no longer works: the fact comes from disk, not response text. Only
`codex-build` runs count—reconnaissance, review, and advice live in the `read-only` sandbox and do
not touch the tree. They can safely run alongside other work; blocking a response because one is a
reading run would spend the attempt budget and then the turn on a run that interferes with nothing.

The guard can stop a turn because the promise “the run is still active” is not a result, while the
worktree is occupied by worker. Form errors are blocked a limited number of times; for external
state, once attempts are exhausted, the guard ends the turn through `continue: false` so an
unconfirmed response cannot pass silently.

## Order gate

`hooks/order-gate.mjs` is the `PreToolUse` hook on the tool that launches a dispatcher. It refuses
the call while it can still be corrected for free: when a required input is missing or still a
template placeholder, when a labelled value carries a shell sequence that would make the command
unmatchable by a permission rule, and when the ordered order id already belongs to a run whose task
text differs — the collision the runner also refuses, caught one step earlier, before Codex is
invoked at all. An explicit continuation grant is the one case that passes.

The gate and the runner share one definition of which task owns an order id
(`lib/runner/order-owner.mjs`); a second copy would drift, and drift between two such lists is what
this package keeps paying for. Uncertain disk state — an unreadable task file, no runs directory
yet, a run folder written a moment before its `status.json` — passes silently, per folder rather
than per directory, so one stray folder cannot disarm the check for every other order.

A dispatcher call carrying `name` or `team_name` is refused before launch: it would start a
teammate, whose `agent_type` is its name and whose handback goes through `SendMessage`, outside the
dispatcher gate.

## Worktree lock

`hooks/worktree-lock.mjs` is a `PreToolUse` hook on file-writing tools (`Write`, `Edit`,
`MultiEdit`, `NotebookEdit`) and on the shell tools beside them. It rejects an edit if the file is
inside a repository held by a live `codex-build` run and names the run directory, agent, slug, and
repository.

The guard reports; the lock prevents: learning about another run and being unable to corrupt its
snapshot are different things, and the 2026-08-05 incident caused false test failures precisely on
the second point. Paths are compared as everywhere in the package—forward slashes, no trailing
slash, case-insensitive, and without `realpath`.

Known limitation: parsing a shell command line is unreliable, and blocking all of `Bash` is
impossible—the run needs builds and tests. `shell-write-intent.mjs` refuses the obvious writing
forms before they run, and `worktree-witness.mjs` compares the tree afterwards against the run's
snapshot; between them a write that slips through is named rather than silently accepted. The witness
judges with the verdict's own instrument — `state-before.txt`, `worktreeSnapshot()`, the environment
split and `outOfScope()` — so the live warning and the final verdict cannot disagree: until Plan_58 it
read `git status --porcelain` on its own and accused a run of editing its own artifacts, the
orchestrator's tooling files and gitignored notes.

## Whether the host still applies a refusal

Every guard above refuses work with `permissionDecision: "deny"`, and the sibling key of that same
object stopped being honoured between hosts 2.1.119 and 2.1.231 without printing anything. The
suite proves a hook returned a refusal; it cannot prove the host applied it.

`codex-bridge doctor` therefore carries a `hostContract` line reporting what is known for the host
that actually ran the session, and a `sessionHost` line identifying that host. Both `doctor` and
`install` judge the newest host version observed in a session transcript. The 2026-09-25 incident
showed why: sessions ran in VS Code extension 2.1.282 while `claude` on `PATH` was 2.1.281, so
judging every contract against `PATH` tested the wrong host. The extension sets
`CLAUDE_CODE_EXECPATH` and `CLAUDE_AGENT_SDK_VERSION`, and every descendant `claude` inherits them;
neither value identifies the session host. Its transcript entry's `version` is the host identity.
The dispatcher gate is registered on every shell call and records that version once per session in
`state/host-observations.json`; session observations are kept for 7 days and host versions for 30.
`doctor` prints one `otherHost:<version>` line for each other observed version (`ok`, `warn` with
the probe command, or `fail` with exit 1). With no observed session, `doctor` and `install` say so
instead of reading `PATH`. The `hostContract` line reports never probed, probed on another host
version, refusals ignored (which names the guards it makes inert and exits non-zero), verified, or
a host whose version cannot be read.

`.host-contract.json` and `state/dispatcher-contract.json` keep one verdict per host version. A
measurement of an executable reporting version V applies to every host of version V; older
single-version files are read as verdicts for their own versions only.

Doctor also reports `handbackWitness` and four dispatcher contract lines:
`dispatcherContract:agentIdentity`, `dispatcherContract:shellStdout`,
`dispatcherContract:shellFailure`, and `dispatcherContract:agentTranscript`. Verified contracts
are `ok`; never probed, another host version, and unknown host version are `warn`. A measured
change is `fail` and exits 1. An unreadable record produces one warning naming its file. Handback
sightings and alarms carry the transcript version, and a sighting matches only that exact version;
an older SDK-based record is treated as no sighting while retaining its alarms. If a subagent stop
has an `agent_id` but no `agent_type`, the reply guard records a versioned alarm and tells the
session that the dispatcher gate cannot recognise dispatchers.

`codex-bridge doctor --probe-contract` performs the measurement. By default it targets the newest
observed host version; `CLAUDE_CODE_EXECPATH` and `claude` on `PATH` are candidates only when their
own `--version` matches it. Use `--probe-executable <path>` to name an executable explicitly;
`--host` selects the Claude Code configuration, not the probe executable. The command prints
`probe: target <version> at <executable> (<source>)`. It builds a throwaway rig outside the
repository, registers one temporary hook there refusing one marker command, runs the target host
inside the rig with only the tool under test allowed and with settings read from the project alone,
and judges by whether the marker file appeared. The verdict is written next to the installation and
bound to the host version, because the host is what updates underneath an installation. A host that
completes the run but writes a different version into its transcript records nothing.

The probe takes up to two minutes and one host session with a short subagent, spent from the
operator's Claude quota, so it never runs on its own: not from
`doctor` without the flag, not from `install`, not from the suite. A run that could not measure —
no executable matching the target version, a crash, a timeout, a hook that never fired — records
nothing and exits `2`; an absent marker counts as a refusal only when the hook fired and the host
survived to the end. The same host run measures the four dispatcher contracts;
`state/dispatcher-contract.json` is written only when the host completed the run.

## Installation into another Claude Code configuration

The installer lays out the files—`codexb install` (or `npm run dev:install` from a clone). There
is no longer anything to copy by hand. The repository's `src/home/` is copied one-to-one into
`~/.lyupro/.codex-bridge/`, so every path below `hooks/` and `lib/` is identical in source and on
the host. `package.json`, required by npm outside that image, is the one documented exception.

| Root | What lives there |
| --- | --- |
| `~/.lyupro/.codex-bridge/` | runner and its modules (`lib/`), guards (`hooks/`), `config.json`, `conventions.md`, installation record `.installed.json` |
| `~/.lyupro/.codex-bridge/state/` | Per-dispatcher state (pruned after 7 days), `host-observations.json` (sessions kept 7 days, hosts 30), `handback-witness.json`, `dispatcher-contract.json`, `reply-guard-tries.json`, and `diagnostics/*.last.json`; `update` removes diagnostics formerly under `~/.claude/logs/` |
| `~/.claude/agents/codex-bridge/` | four agent definitions—Claude Code reads them only from here |
| `~/.claude/commands/codex-bridge/` | two command files: `/codex-bridge:env` and `/codex-bridge:usage` |
| `~/.codex/rules/` | Codex CLI rules file; the directory is not ours |

Agent and command markdown is placeholder-processed on install, and the frontmatter is re-emitted as
valid YAML afterwards: any value a YAML reader would not take as a plain scalar is double-quoted.
This is not tidiness. On 2026-08-10 the stop-guidance sentence — `` before `TaskStop`: TaskStop
removes the wrapper … `` — entered `description:` unquoted, and a colon followed by a space starts a
nested mapping, so the frontmatter did not parse and Claude Code registered none of the four
agents for five days while `doctor` reported every file present. `doctor` now parses each installed
definition and checks its `name`, and the suite parses everything the installer would write. A definition whose content differs from the packaged one is reported as `fail` and exits 1 rather
than warning: the drift that matters is a call form no permission rule matches, and a host in that
state stops every delegation while looking healthy to a script. The remedy printed with it is
`codex-bridge update --force`.

Exactly this minimum remains in external directories: an agent file elsewhere means the agent
does not exist. Symlinks from `~/.claude` to our directory were rejected—creating them on Windows
requires administrator rights, so installation would fail for an ordinary user.

Command files are shipped specifically as copies. Claude Code determines a command's namespace
from the file's physical location and does not understand symlinks or pointer files for this
purpose—therefore renaming the directory changes the command prefix.

Hooks are registered in `settings.json` **by invocation**, not by file path:

```json
{
  "hooks": {
    "SubagentStop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "codex-bridge hook reply-guard",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

This keeps file moves and runtime version changes from becoming edits to someone else's
configuration. Guard names are `reply-guard`, `order-gate`, `worktree-lock`, `prune-guard`, and
`stop-guard`; each guard's matcher is defined by the package itself. The `SubagentStop` matcher may
cover all subagents: the guard itself passes types other than `codex-scout`, `codex-build`,
`codex-review`, and `codex-advisor`.

If the command is not visible through `PATH` (installation through `npx`, a clone without
`npm link`), the installer writes the full path to the guard copy in
`~/.lyupro/.codex-bridge/hooks/`. `doctor` prints which form was recorded and why, together with the
version that form will actually start: the command form executes code from the globally installed
package; the path form executes the copy placed by the latest installation.

If `settings.json` already has a `SubagentStop` group, the installer adds the command hook to the
existing structure without replacing unrelated hooks and backs up the file before writing.

What remains is to check `codex --version` and Codex CLI authorization—the package does not install
them.

## Documentation for maintainers

- [Run lifecycle](run-lifecycle.md)
- [`worker.json` contract](worker-contract.md)
- [`status.json` and `meta.json` formats](artifact-formats.md)
- [Verdict computation order](verdict.md)

Operator checklists (`docs/checklists/`), plans (`docs/plans/`), and one-off audits (`docs/audits/`)
are not part of the repository: they are detailed working notes for the maintainer and live only
on their machine. They are absent from a fresh clone.
