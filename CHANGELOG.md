# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- No Claude Code host had registered the three dispatchers since 2026-08-10. The stop-guidance
  sentence added that day — `` before `TaskStop`: TaskStop removes the wrapper … `` — was
  substituted into the `description:` line of each agent's frontmatter, and an unquoted YAML scalar
  cannot contain a colon followed by a space: the frontmatter did not parse, so the agents did not
  exist as far as the host was concerned. `doctor` reported every file present the whole time,
  because it counted files instead of reading them. Installation now re-emits frontmatter as valid
  YAML — any value a reader would not take as a plain scalar is quoted, the sentence survives
  verbatim — `doctor` parses each installed definition and checks its `name`, and the suite parses
  everything the installer would write.

- A run ordered under another run's order id is no longer answered with that run's verdict. On
  2026-08-15 a build ordered as `plan42-run3` carried the id of `plan42-run2`, and the runner
  printed run2's `OK`, run2's file list and run2's suite over a worktree where nothing had been
  done — only a manual `git status` stopped a commit of work that did not exist. An order id names
  one task: when the id already belongs to a run whose task text differs, the runner now refuses
  with exit code `2` before printing anything, naming the folder that owns the id and the two
  remedies (a new `--order-id`, or `--continue`). Repeats of the same task, continuations, and runs
  recorded before the `task_hash` field attach exactly as before.
- The same collision is now refused one step earlier and checked one step later. `order-gate` denies
  the dispatcher call itself when the ordered id already belongs to a run with a different task —
  before any quota is spent — and `reply-guard` blocks a reply whose run records a different
  `order_id` than the one the orchestrator ordered, read from the dispatcher's own transcript. Both
  read the single definition of "the same task" the runner uses; a second copy of that rule would
  drift silently, which is the failure this change exists to end. Every uncertain disk state — an
  unreadable task file, a missing runs directory, a run folder written before its `status.json` —
  passes, because a guard nobody can predict is a guard everyone works around.
- Delegating to a dispatcher no longer stops on a permission prompt. The shipped agent definitions
  started a run by absolute path — `node "<installed dir>/run-codex.mjs" --agent … \ …` — and a host
  matches permission rules against the beginning of a command line, so a rule written for this
  package could never match it. The only way to start a run is now the package command,
  `codex-bridge run`, on a single line: no interpreter, no path, no line continuation. The task
  statement travels as `--task-file`, because a heredoc forces the invocation back into the
  multi-line form that no rule can cover; stdin remains supported for the direct call, and giving
  both channels is a refusal rather than a silent precedence.
- Installed hooks could not run at all. The installer reshaped the source tree — hooks to one
  directory, their modules to another — so every hook's relative import was correct in the clone and
  false on the host, and all five guards died on `ERR_MODULE_NOT_FOUND` from the day the package
  moved to its branded folder. The suite stayed green because it exercises the clone, and `doctor`
  called a hook healthy on the strength of a line in `settings.json` without ever starting the file.
  The source now contains a literal image of the installed home, `src/home/`, and installation
  copies it one to one.
- The reply guard no longer sends a refused dispatcher down the one road the host cannot allow.
  Seven of its block texts said "Run run-codex.mjs and return its stdout verbatim" — the sentence
  removed from every prompt in this release, because a command line naming a file can match no
  permission rule. They were the worst place for it to survive: a dispatcher reads them at the one
  moment it is looking for what to do next, having just had its answer rejected. All seven name
  `codex-bridge run`. The invariant behind them was the actual defect and is now stated as a rule
  rather than as a shape: no line of code in a hook may name the runner file, whole-line comments
  excepted. The earlier expression-bound check could not see the text a session is shown when its
  turn is ended, which is where the same sentence would have survived a fourth cleanup.

### Added

- `codex-bridge run` — the public entry point for starting a delegated run, with the same flags,
  stdout and exit codes as the historical file invocation.
- Both lines that identify a run to its caller carry the order they belong to:
  `RUN=<path> order-id=<id>` and `ATTACH=<path> order-id=<id> started=<time>`. A reply naming a run
  cannot be checked against the order that was placed unless the id travels with the folder.
- Two structural guards that make the above regressions loud instead of silent: the install plan
  must stay isomorphic to the shipped home image, and every registered hook must actually start as
  a child process with its imports resolved.
- `doctor` compares the version answering a hook against the installed copy, verifies the installed
  agent definitions against the repository, and downgrades to a warning instead of reporting code it
  never ran as healthy.

## [0.5.1] - 2026-08-12

### Fixed

- Installing or uninstalling no longer fails over a rules-registry lock that is busy for one more
  millisecond. Windows answers a taken lock with three codes, and only one of them is `EEXIST`: a
  lock file whose delete is still pending comes back `EPERM`, and a file another process still
  holds comes back `EBUSY` — the acquisition loop treated both as fatal instead of waiting. All
  three now mean "not yours yet", and the decision lives in one exported check, `isLockTaken()`.

### Changed

- The README's first screen names the problem the package solves, keeps the install command inside
  the first 30 lines, adds a second badge row, and shows `doctor` output from a healthy host in
  place of a screenshot.
- The reference documentation under `docs/` is English-only now (`overview.ru.md` became
  `overview.md`), and the working folders — plans, checklists and audits — left the repository and
  its history: a fresh clone contains the five reference documents and nothing else.

## [0.5.0] - 2026-08-11

### Added

- A fifth host guard now catches `TaskStop` while a live Codex run is still writing to the
  repository, names the run and points to `codex-bridge stop <run>` before allowing a repeated
  request. `doctor` and `projects` also surface active runs, so stopping a dispatcher wrapper is
  no longer mistaken for stopping its detached worker.
- `codex-bridge hook <name>` gives Claude Code a stable way to invoke each installed guard, and
  `meta.json` now records the package version that produced a run. The usage report can therefore
  separate historical runs made outside this runner from runs that should satisfy its sandbox
  contract.

### Changed

- **Breaking:** the installed package layout now uses `agents/codex-bridge/` instead of
  `agents/codex/`, `commands/codex-bridge/` instead of `commands/codex/`, and
  `~/.lyupro/.codex-bridge/lib/` for the runner and guards. Slash commands are now
  `/codex-bridge:usage` and `/codex-bridge:env`, and hooks in `settings.json` use
  `codex-bridge hook <name>` when the matching package version is available. Run
  `codex-bridge update` to migrate an existing installation and retire the old layout.
- Runs started without an explicit `--slug` now derive a readable folder name from the required
  order id instead of grouping unrelated work under the dispatcher name. Existing run folders
  remain discoverable by their order id and task fingerprint.
- The README now leads with the package's guarantees, verification and update guidance, and
  limitations before the command reference, and the repository now publishes a security policy
  and private vulnerability-reporting route.

### Fixed

- Guards invoked through a global-install symlink no longer exit successfully without running;
  the direct-invocation check now compares resolved files, so a silent guard cannot allow every
  operation while `doctor` reports it healthy. Hook registration also chooses the short command
  form only when the command on `PATH` is this package's exact version, rather than merely present.
- Retiring the previous layout no longer removes the shared Claude Code `agents/` and `commands/`
  directories. Seeded operator files are moved only after byte verification, and an interrupted
  migration is retried by the next `update` even when the new files are already current.
- A continuation grant that loses its `--continue` flag is now refused before attachment instead
  of replaying an older run's verdict as though new work ran. Attachment output also states
  explicitly that no new work was started.
- The test suite now isolates both installation roots, preventing tests from writing fixtures or
  seeded configuration into the operator's real `~/.lyupro/.codex-bridge/` directory. Migration
  dry runs also name the hook event and matcher instead of printing `undefined`.

## [0.4.0] - 2026-08-09

### Added

- Scope patterns are checked before Codex starts. A pattern that cannot match anything — an
  absolute or drive-qualified path, backslash separators, a `..` segment, or a spelling no
  repository file answers to — is refused with no run folder and no quota spent, for all three
  dispatchers. The file list comes from `git ls-files --cached --others --exclude-standard`, so
  ignored output does not count as repository content. A file the run is meant to create is
  declared with `--scope-new`, accepted only by `codex-build` and recorded in `worker.json`.
- `codex-bridge permissions` reports, adds, and removes the optional shell permission rules for
  both CLI names and the clone entry point. The exact allow and deny strings merge into
  `settings.json`, preserve foreign rules, and are also removed by `uninstall`; `doctor` reports
  an absent or partial set as an optional warning.

### Changed

- `codex-bridge sweep` is now `codex-bridge unlock`. The default scope is the current repository;
  a bare project name remains addressable, and `--all` is now required for the whole store. The
  report shows age, silence, and `alive` / `dead` / `foreign` / `unverified` identity verdicts;
  confirmed-alive records are refused with `codex-bridge stop <run>` instead of being closed.

### Fixed

- Run records now verify that a pid still belongs to the process that started the run, using the
  process start time and a fresh heartbeat before falling back to an OS probe. A reused or
  unverified pid is never signalled by `stop`; `codex-bridge unlock` remains the non-killing way to
  close a record whose process identity cannot be confirmed.
- JSON files written by PowerShell with a UTF-8 BOM are now read consistently by the CLI and
  installed hooks, and one command run creates at most one settings backup without deleting older
  backups.
- A run a guard refused before Codex ever started no longer costs the next attempt a round trip. Such a folder now closes as `aborted_pre_start` instead of the same `failed` a twenty-minute paid run gets, and the chain gate, the continuation limit and the tree baseline all skip it: the same order id starts as a first run, silently, with no `continue:` grant. Reported from a parallel `codex-build` launch — the second run was correctly refused with "two writing runs in one tree are prohibited", and its one-millisecond folder then made the retry demand a grant for work that never happened. Folders written before this release are recognised by what `meta.json` records — `exit`, `session_id`, `events_bytes`, `stderr_bytes`, `tokens_reported` — rather than by whether `events.jsonl` is still on disk, because retention deletes that file from paid runs too. The folder itself is kept: it is the audit trail of who was refused and why.
- `chainBaseline()` takes the first run of the chain that actually started, so a pre-start folder sorting first no longer leaves the next pass without the `state-before.txt` its work is measured against.
- `uninstall --dry-run` names each hook by its own matcher. Three of the four hooks are PreToolUse,
  and a lookup by event alone reported `Agent|Task` for the worktree lock and the prune guard too —
  in the one line an operator reads to see what a removal is about to touch. The removal itself was
  never affected: hooks are found by command, not by matcher.
- The order gate's refusal now shows the line it found. A caller who wrote
  `scope (you may create/modify ONLY these):` was told scope was missing, re-read their own prompt,
  saw it written there, and had nothing to act on; an autonomous run rewrites the same text forever.
  The refusal names the candidate line under the input it belongs to and says why it was not
  accepted — a qualifier between the label and the colon, a value that is still a placeholder, or no
  separator at all — and stays silent when no candidate exists, because then "the input is missing"
  is the truth. The parser accepts exactly what it accepted before: deriving scope from prose would
  give away the only guarantee that a run cannot touch files nobody listed.

## [0.3.1] - 2026-08-07

### Added

- The CLI answers to `codexb` as well as `codex-bridge`, and README now documents the global install that puts both names on `PATH`. Every spelling that can reach deletion comes from one frozen list, and the prune guard builds its matcher from that list rather than repeating the names — two independent lists drift silently, which is exactly how the installer and test hook lists had already drifted. The full name stays primary: the docs, checklists and three agent prompts are written with it.
- Every run carries the rules it is judged by. A seeded `conventions.md` beside `run-config.json` and an optional `.codex-conventions.md` in the repository being worked on are pasted into `task.md` verbatim, under one `## Conventions` section. Either file missing is not an error, and a blank one produces no section at all — rules handed over as an empty heading read as rules ignored. Until now project rules reached a run only when the orchestrator remembered to write "read CLAUDE.md" into the task, and six acceptance passes in a row caught the same class of violation: the rule existed, applied, and had not travelled. Pasting rather than referencing is the point — "read file X" is hope, and a run is free not to.
- `doctor` opens with the path of the package copy answering, marked `clone` or `installed package`, and reports whether the host conventions file was found, warning when it exists but is empty. A global install puts a second copy of the package beside any clone, and `update` copies host files from whichever copy launched it — so two diagnoses of the same host were previously indistinguishable.

### Fixed

- `codex-bridge projects` printed the `last run` column on two clocks. Folder names are written in local time and `meta.finished_at` is an ISO stamp in UTC, and each reached the column through its own branch, so a run whose folder says `144243` was listed as `12:46` — the operator's own zone offset, indistinguishable from a different run. Which run is newest was never affected, only how it printed.

## [0.3.0] - 2026-08-07

### Added

- `codex-bridge sweep [<project>]` closes running records whose runner pid is dead, across the whole store or one project. It changes state but deletes no run folder or transport, never touches a live pid, and lists every stalled-but-live run with the exact `codex-bridge stop <run>` line that ends it. A dead record can therefore be cleared without paying for another run, while a live worker remains the sole writer until `stop` kills it first.
- Every new run folder carries a `heartbeat` file, and `status.json` carries `stdio_drained`. The heartbeat records movement from Codex output and the still-running child rather than a timer that would keep an orphan alive; `stdio_drained` says whether stdout/stderr closed normally or the bounded drain grace had to end the run.

### Changed

- Hook liveness now requires `state: running`, a live runner pid and a heartbeat no older than five minutes. A stalled run therefore stops holding the worktree lock instead of holding it until the deadline; the refusal that remains — always about a working run — says how long ago it last made progress and prints `codex-bridge stop <run>` for taking the repository back early. Record cleanup and the second-writing-run check still judge by pid alone, so a stale but live run is released to the operator, not closed underneath its worker.
- The worker closes a run after `exit` with a bounded 30-second grace for stdio drain instead of waiting for `close`, which a grandchild can hold open forever. Healthy runs keep the event tail that carries their result and record `stdio_drained: true`; only the fallback records `false`.
- The three dispatcher prompts now open with one shared no-self-execution block rendered through `{{CODEX_NO_SELF_EXECUTION}}`. If `run-codex.mjs` does not start a run, the dispatcher must return `FAIL` and stop, and a reply with no run folder is blocked by the guard. The installed prompts change only when the host runs `codex-bridge update`; a host that does not update keeps the old prompts.

### Fixed

- A dispatcher that cannot start Codex can no longer read the code, write the files or fix the tests itself and claim a result. The guard also rejects a made-up reply with no `RUN=` or `ATTACH=` behind it: no run, no result.

## [0.2.0] - 2026-08-06

### Added

- `codex-bridge projects` gives the run store a way to look at itself: one line per project — runs, weight, tokens spent, how many are running right now, when the last one started — and one line per run under a project name, plus `--json` for scripts. The store had grown to 12 projects, 152 runs and 80 MB with no command that could answer "what has Codex been working on"; the only way in was a file manager. The count of live runs is computed by the same module the reply guard and the worktree lock use, because a second detector of a live run sitting next to the first would drift from it silently.
- `codex-bridge prune` reclaims that space, and it is built to be hard to fire by accident: without `-f` it prints a plan and deletes nothing, `-f` still asks before each step, and with no terminal it refuses outright — deletion is an operator action, and the bypass flag that would undo this is deliberately absent. A gentle prune removes transport only (event streams, stderr, the archived `raw.log` of older runs) and leaves accounting, reports and worktree snapshots in place, so a task can still be continued and still be read after its megabytes are gone; `--purge` is what takes a folder whole, and it is refused together with `--all-projects`, because deleting a dozen projects with one command has no second line of defence. A live run is never a target — it is recognised by its process, not by a status file, since the file that would be deleted is the verdict being written right now.
- Run transport is dropped automatically from runs older than 30 days when a new run starts, and the dispatcher's reply says how much was freed: a rare event that goes unexplained sends someone looking for a fault. Automatic cleanup can only shed weight — the code to remove `meta.json` or a folder does not exist on that path at all, so it cannot be switched on by mistake — and `retention` in `run-config.json` changes the age or turns it off. Both `install` and `doctor` say out loud that it is on, because an installer that quietly starts deleting files is a surprise, not a convenience.
- A fourth hook refuses `codex-bridge prune` in an agent's shell command before the deleting process exists. Mentioning the command is not calling it: heredoc bodies and quoted text are stripped before the check, after the guard rejected the very commit that introduced it over a command name in the message. `git prune` and `npm prune` are left alone — a guard that breaks unrelated work is a guard that gets removed, and then it protects nothing.
- `codex-bridge read <run>` renders a run's events as text on demand. Readability is now something the package produces when asked rather than a file it keeps, and a rendering that is not stored cannot disagree with the facts.

### Changed

- Runs go through `codex exec --json`, and `events.jsonl` is the single source of the quota signal, the token count, the session id and the failure reason. The stream is written by the CLI, not by the model, so a quotation out of a source file can no longer reach it. `tokens` is input plus output with the CLI's whole `usage` object beside it, and `session_id` comes from `thread.started` instead of a line matched in a log.
- The reason for a `FAIL` is taken from the run's own error event rather than from `stderr.log`. A live probe showed `stderr.log` is not empty even for a clean run — 488 bytes of execpolicy refusals, repository paths included — which made the reason a random blocked call instead of the real one. The transport branch keeps the reason the CLI itself gave with its status code: a `LIMIT` whose reason does not mention the quota is the same class of defect.
- A run that never began is one with no events *and* no stderr. Stderr with no events is a CLI that did not understand a flag — a different diagnosis, calling for a different action, and the two no longer collapse into one.
- `log_bytes` in `meta.json` is replaced by `events_bytes` and `stderr_bytes`.

### Removed

- `raw.log` is gone. Under `--json` it would have been a byte-for-byte copy of `events.jsonl` — a second source of truth with no role of its own — and the package already declared it ephemeral and safe to delete while resting the "abandoned at start" verdict on it. An artifact one is allowed to remove cannot be the ground of a verdict.
- The text detector of the quota signal is removed entirely rather than kept as a fallback. While the regular expressions live, so does the class of defect they caused.

### Fixed

- `LIMIT` is set only by an error event from the CLI carrying `status: 429` or an error type naming the limit. A `codex-build` run that had finished its work grepped the package's own test fixtures, printed a line where `ERROR` and `rate limit` stand together, and was closed as quota-exhausted — the work was complete and the suite was green, and the verdict threw it away.
- A run killed by its time budget says so. It records `stopped_on_deadline` and answers `FAIL — run stopped on its deadline`, instead of inventing a reason out of whatever text was nearest.
- A log file that cannot be written no longer leaves Codex orphaned. An unhandled stream error used to kill the worker while the CLI kept burning quota with nothing left to close it; now either stream failing takes down the process tree, so the run dies with its process rather than instead of it.
- A run that exited honestly is no longer marked as killed by its deadline. The timer judged by `close`, which a grandchild process can hold open long after the run is over; it now watches `exit`.
- A verdict is never shortened to fit the terminal. In a narrow window `running` was printed as `…nning`, which reads as a damaged run rather than one still in flight; a verdict is one word from a known set, like a number or a date, and the run name is what a narrow table gives up instead.
- The CLI's own warnings are no longer read as the model's complaint about the order. `codex-cli` announces a deprecated configuration key through the same event shape the model uses for a content error, before the turn even opens — so a failed run on such a host would have answered "`[features].codex_hooks` is deprecated" when asked why it failed. Only events after the first `turn.started` are the model's; a complaint about the order cannot predate the model's first thought.

## [0.1.4] - 2026-08-05

### Added

- A continuation has to prove the orchestrator ordered it. `--continue` is refused unless the task text carries a `continue:` grant naming the run being continued and why, and the refusal costs nothing: no run folder is created and Codex is never started. The grant is single-use by construction rather than by a counter — continuing the last run of a chain appends a later one, so the same line stops matching by itself. Until this release a dispatcher could decide on a second pass alone: one did, spent 75 691 tokens of the Codex subscription and created a module the order never asked for.
- A reply that stays silent about a live `codex-build` run of the same project is blocked. The guard reads the project's runs folder from disk instead of trusting the paths the reply chose to mention, so a second run can no longer be left working in the background while the verdict of the first is handed back. Runs of `codex-scout` and `codex-review` are not counted: they hold a read-only sandbox, and blocking a reply over one would spend the guard's budget on a run that touches nothing.
- A `PreToolUse` lock refuses file edits inside a repository held by a live `codex-build` run. Knowing that a run is live is not the same as being unable to disturb it — edits made during that window land in the runner's before/after snapshot and fail an honest run for work it never did. An edit made through `Bash` still walks past the lock; parsing a command line is not something a guard can do reliably.

### Fixed

- `doctor` names the file each hook was registered for. With two hooks on one event it matched the installation record by event alone and reported the worktree lock's matcher as pointing at `order-gate.mjs` — the one line where an operator can check what is installed, showing the wrong file.
- Hook presence is decided by this package's own command rather than by the matcher it currently sits under. The matcher is generated from the list of host tool names and grows whenever a spelling is added, so a host installed under the previous matcher would collect a duplicate hook on update and keep a hook pointing at a deleted file after uninstall.

## [0.1.3] - 2026-08-05

### Added

- Dispatcher calls are refused before a subagent exists. A `PreToolUse` gate rejects a `codex-*` call whose task text carries no order label — and, for `codex-build`, no scope — or whose value is still a template placeholder. Until this release the missing input was discovered by the runner, after the subagent had been created and paid for out of the Claude subscription.
- `codex-build` declares the outcome of its own run in a required `outcome` field. A run that could not do the work reports `fail`, and the verdict goes red with the reason even when the worktree is clean and verification is green — the shape that used to answer `OK`, because an empty delta is a legitimate outcome the runner cannot tell apart from a failure. Whether a run owed that declaration is read from the response schema it was handed, so runs recorded before this release keep the verdict of their own day.

### Changed

- Every dispatcher's description and prompt lists the inputs it requires, filled in at install time from the same table the gate enforces, and the runner's own refusals name the input, an example value and what to do about it. A caller no longer learns the contract by being refused.
- A failed `codex-build` reports what it left in the worktree, the way a quota-exhausted run already did. "The work was not done" is not "the tree is clean", and where no snapshot exists the line says so instead of claiming there were no changes.
- The installation record stores a list of hooks rather than a single hook, so a host can register more than one. Records written by earlier versions are read as a one-element list.

## [0.1.2] - 2026-08-04

### Fixed

- A damaged ownership registry no longer breaks the command that reads it. Every command parses the registry before its first write, `doctor` reports the damage as a failed check while still printing the other eight, and `uninstall` finishes removing the package but keeps the shared rules file, because ownership is unknown and disarming another installation is worse than leaving a file behind. Until this release an `uninstall` on a damaged registry stopped after the hook was gone, leaving the host with every package file and no reply guard.
- Owner updates are written through a temporary file under a lock, so two installers running at once merge instead of overwriting each other. The lock expires: an interrupted run used to leave it behind, and every later install and uninstall then died on it until someone deleted the file by hand.
- Installation claims its share of the rules file before writing anything. Claiming it last meant a failure at that step left a fully installed host missing from the registry, and the next uninstall elsewhere would delete the rules out from under it.

## [0.1.1] - 2026-08-04

### Fixed

- Two runners starting at the same moment in equally named repositories no longer fail on the exclusive writes that assign a runs directory: the runner that loses either race now reads the marker the winner wrote and takes the next candidate, which is the collision the marker was introduced to survive.
- A repeated order is answered from its newest run instead of the pass before it: while a continuation was in flight, repeating the command returned the previous run's verdict as if it described the current one.
- Uninstalling one installation no longer takes the Codex rules file away from every other installation on the machine. The file lives in `CODEX_HOME`, which is shared by every host, while ownership was recorded per host and two installations of the same version share a fingerprint — so removing a project-scope or throwaway host silently left the remaining ones running Codex without the execpolicy that forbids destructive repository work. Ownership is now tracked next to the file itself, and the last owner to leave is the one that removes it.

## [0.1.0] - 2026-08-04

### Added

- Three dispatcher agents for reconnaissance (`codex-scout`), scoped implementation (`codex-build`), and independent review (`codex-review`), each with a structured response contract.
- A delegating runner that separates the launcher from a detached worker, preserves run artifacts after a dropped call, and supports configurable artifact roots.
- A zero-dependency `codex-bridge` CLI with `install`, `uninstall`, `update`, and `doctor`, including user/project scopes, dry runs, force handling, idempotent installs, hook merging with backups, and manifest-based ownership tracking.
- A reply guard hook that blocks dispatcher replies that do not match the recorded run state or required response shape.
- Run-chain and busy-tree lock protections: repeated work is linked across runs, an unfinished chain requires explicit `--continue`, and concurrent writing runs for one repository are refused before Codex starts.
- Scope and coverage validation: implementation changes must stay within the declared scope, report/worktree mismatches fail the run, and reconnaissance reports must account for all requested subquestions.
- Package-managed Codex execution rules that forbid history-, branch-, index-, and worktree-destructive operations, writes inside `.git`, and other unsafe repository mutations while leaving the operator's existing rules untouched.
- A 400-line source-file size gate with explicit rationale required for exclusions.
- Asynchronous run start: the launcher reports the run folder and returns instead of holding the caller for the length of the run, and repeating the same order attaches to the run already in flight rather than paying for a second one.
- Per-mode time budgets that end a run and its whole process tree at a deadline, plus a `stop` subcommand for closing a run that wedged anyway.
- Explicit reconnaissance subquestions through a mandatory, repeatable `--question` flag, so coverage is counted against what was ordered rather than against prose the dispatcher rewrote.
- An `answerLanguage` configuration key that fixes the language of a run's answer instead of leaving it to the model.

### Changed

- Run identity now includes an orchestrator-issued mandatory `--order-id`, stored with run state and used alongside the task identity to detect repeats even when a run is renamed.
- A repeat of an order is now continued at most once, and only behind a run that already carries a verdict, so a dispatcher can no longer restart itself into a chain of paid runs.
- A run left behind by a dropped call is now closed with a `FAIL` verdict that names what it left in the worktree, instead of staying open with no account of its work.
- Runs now snapshot both branch and `HEAD` before and after execution; branch changes, detached `HEAD`, and commit drift are treated as failures, with preflight refusal for a subsequent run when an abandoned run left repository state out of sync.
- English-language prompts and runner/command output are shipped for the three dispatchers and their supporting commands.
- Installation updates track installed file contents so outdated package files can be refreshed without overwriting hand edits unless `--force` is requested.

### Fixed

- Prevented environment and service writes from being misreported as delegated work while keeping them visible in run results.
- Prevented different repositories with the same directory name from sharing run history.
- Prevented malformed state files, including files with a byte-order mark, from silently bypassing abandoned-run detection, busy-tree locking, and chain lookup.
- Fixed diagnostics to report the run folder actually used by the runner and to continue reporting remaining checks when a project marker is unreadable.
- Fixed reported file paths to keep the spelling on disk instead of the case-folded form used for matching, so a reply names a path that exists on case-sensitive filesystems.
