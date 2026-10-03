# Contracts that break silently

Cut verbatim from `CLAUDE.md` on 2026-08-16 (Plan_47 §9): these rules are needed by the sessions
that touch the mechanisms below, not by every session, and the router in `CLAUDE.md` sends you
here. Nothing was reworded on the way out.

- **Verdict check order is the contract**, not an implementation detail — `resolveStatus()` returns
  on the first hit. See `docs/verdict.md` before reordering or inserting a check.
- **`LIMIT` comes only from a CLI error event**, never from text. Runs go through `codex exec
  --json`, and `meta/events.mjs` admits only `type: "error"` and `turn.failed` as transport
  evidence. `item.completed` carries the model's own words — a run quoting "rate limit" out of a
  source file once became a false `LIMIT` and threw away finished work.
- **Artifact write order**: `status.json` first, `worker.json` complete before `spawn()`,
  `meta.json` before `status.json` is closed, `reply.txt` last. `reply.txt` existing means the
  verdict is already on disk.
- **The worker takes its whole order from `worker.json`** and never re-reads the CLI or
  `config.json` — otherwise one run gets two different configurations. See
  `docs/worker-contract.md`.
- **`src/home/config.json` is seeded, never overwritten.** It is the host's file (models, effort,
  `environmentPaths`), like a `.env`. `SEEDED_SOURCES` in `cli/manifest.mjs`.
- **A seeded file is read from the host home, never from the package.** `src/home/lib/brand-home.mjs`
  is the only resolver of that home (`CODEX_BRIDGE_HOME`, else `~/.lyupro/.codex-bridge/`); no module
  derives the path from its own location. The runner did exactly that until 2026-08-26 and read the
  package copy for three releases while the operator edited the home one — a pinned model and effort
  reached no run at all, and `doctor` confirmed the setting because the CLI resolved the path
  correctly. `tests/run-config-reaches-the-run.test.mjs` is the end-to-end gate; a unit test that
  injects the profile cannot catch this class and did not.
- **`src/home/lib/config-edit.mjs` is the only writer of the host config.** It edits the raw file
  and leaves every other key byte for byte; nothing else in `src/` or `cli/` may know the config
  path and call a writing API, and `tests/one-config-writer.test.mjs` fails when one does. The
  reader merges defaults, so a writer that persisted the reader's object would freeze them into the
  operator's file — worst of all `environmentPaths`, the list the package extends as it finds new
  paths, which decides whether a change is charged to the run or to the environment.
- **`codex-runs/` is user data.** Uninstall never touches it; the install record is forbidden from
  naming it.
- **Model ids live only in `config.json`.** No model literal belongs in `.mjs` code.
- **`src/home/lib/cli-names.mjs` is the only list of CLI spellings.** `bin`, the prune guard's matcher and
  anything else that has to recognise a call read it from there. Two independent lists drift
  silently — exactly how the installer and test hook lists had already drifted before Plan_19.
- **Windows paths are compared normalized** (forward slashes, no trailing slash, case-insensitive)
  and symlinks are deliberately not resolved: `realpath` returns `\\?\` and UNC forms. The single
  exception is `cli/invoked-directly.mjs`, which resolves both sides: there the question is whether
  two paths are the same file, not what a path is, and comparing them as written let `npm i -g .`
  silence every guard.
- **The shipped agents start a run through `codex-bridge run`, on ONE line, and never by path.** A
  host matches permission rules against the beginning of the final command line, so an interpreter,
  an absolute path or a line continuation makes the call unmatchable and every delegation stops on a
  permission prompt. For the same reason the task statement travels as `--task-file` (absolute path,
  written by the orchestrator) rather than a heredoc, and `task file` is a required dispatcher input
  the order gate enforces. `tests/agents-command-boundary.test.mjs` fails on any regression.
- **No free text reaches the command line at all.** Scout questions and the verification command
  live in the task file, under `Questions` and `Verify` headings; the dispatchers no longer pass
  `--question` or `--verify`. One list of forbidden sequences — `src/home/lib/shell-unsafe.mjs` — is
  read by all three layers that police this: the order gate, the runner and
  `tests/shell-unsafe-arguments.test.mjs`, which also checks the examples in `docs/overview.md` and
  `README.md` for continuations and relative task-file paths. Never restate the list anywhere.
- **Every child process in `src` or `cli` hides its console window: `windowsHide: true` at the call
  site.** The run worker is spawned detached, so on Windows it owns no console, and each console program
  it starts without the flag opens a visible window — on 2026-09-24 the before/after `git` snapshots
  flashed a burst of black windows over the operator's screen at the end of every run. A spread of
  options the scanner cannot follow does not count; say it again at the call.
  `tests/child-process-hidden-window.test.mjs` fails otherwise (it shares its scanner with the shell
  guard, `tests/child-process-scan.mjs`).
- **No child process in `src` or `cli` is started through a shell.** The `shell` option may only be
  the literal `false` (omitting it is the same thing and how most calls are written), and
  `exec`/`execSync` may not be imported at all, since they always use one. `tests/no-shell-child-process.test.mjs`
  fails on either. The `.cmd` shim npm writes on Windows is the standing temptation — it cannot be
  executed without a shell, so `reachableCommandVersion` ran with one until Node 24 answered every
  `install` and `update` with a DEP0190 security warning ahead of its output. The shim is now located
  on PATH and handed to `cmd.exe` as `['/d','/s','/c', '""<path>" --version"']` with
  `windowsVerbatimArguments`, the only spelling that survived a probe over five directory names; the
  interpreter comes from `ComSpec`, never from the PATH handed in, because a caller's trimmed PATH
  would otherwise turn the version check into a silent null and send installs back to writing full
  paths into hooks.
- **The installer is the package; the runtime is the home.** `codex-bridge hook <name>` is only a
  launcher: it resolves the home through `brand-home.mjs` and imports one home file,
  `lib/hook-entry.mjs`, which owns the name list and the guard import. It never falls back to the
  package's own `src/home/`. Every launcher-side failure (unknown name, no home, import error) exits 1
  with a stderr line and runs no guard; exit 2 belongs to a guard's own deliberate refusal. Why: on
  2026-09-24 a clone install registered three new names against a global 0.6.6 whose package copy did
  not know them, `hook` answered 2, and every Bash and PowerShell call on the machine was refused.
  `tests/cli/hook-home-launcher.test.mjs` holds it. `codex-bridge run` follows the same rule through
  `cli/run-launcher.mjs` (the home's `lib/run-codex.mjs`, no package fallback,
  `tests/cli/run-home-launcher.test.mjs`); a test that spawns `bin run` gives it a home image with
  `tests/home-image.mjs`, or it would execute the operator's installed runner. The installer writes
  the short `codex-bridge hook <name>` only when `hook --home` on PATH proves a launcher of the current
  protocol serving this very home (`cli/launcher-probe.mjs`); a version comparison proves nothing,
  since a clone carries the previous release's version.
- **The host is named by the `version` in its own transcript, nothing else** (Plan_66 D4). Contracts,
  the handback witness and the probe target are judged against versions sessions recorded
  (`src/home/lib/host-observations.mjs`), never against `claude --version` from PATH and never by
  `CLAUDE_CODE_EXECPATH`/`CLAUDE_AGENT_SDK_VERSION`: on 2026-09-25 the VS Code extension 2.1.282 ran the
  sessions beside PATH 2.1.281, and both variables are set once by the extension and inherited by every
  descendant `claude`. An executable is a probe candidate only when its own `--version` matches; with no
  observation the answer is "not observed", never a quiet fall back to PATH.
- **A refused dispatcher fails; it never routes around the refusal.** No `run-codex.mjs` by path, no
  interpreter, no retry in the other shell, and never advice to grant a rule on an internal file.
  The self-execution block names the command only — it once said "start a run through
  run-codex.mjs", and a dispatcher followed that sentence into three unmatchable calls in a row.
- **`install` grants the permission rules in the scope it installed into**, global or `--scope
  project`. `uninstall` removed them long before install granted them, and a host without the rule
  refuses the package command.
- **Agent and command markdown is placeholder-processed** on install: `{{CODEX_BRIDGE_DIR}}` becomes
  the installed runner directory, `~/.lyupro/.codex-bridge/lib/` — not the directory the markdown
  itself lands in. Keep the placeholder, never a real path.
- **The sandbox is probed before the run exists, and the probe can never hang the launcher.**
  `probeSandbox()` runs once the tree is free and before retention or the run folder, asks the
  sandbox to echo a marker with exactly the flags the role will get, and calls it dead only on
  double evidence (role flags and a flagless control, no argument error, `--version` still
  answering). Every other outcome starts the run and travels into `status.json#sandbox_probe` and
  the reply, because a Codex release that stops accepting the flags must not turn the check off
  silently. `stderr` is quoted for the operator and never parsed. The only capture is
  `spawnCaptured()` in `src/home/lib/runner/codex-cmd.mjs`: asynchronous, a required timeout rather
  than a default, and on the deadline it stops the whole tree through `stopCodex()` — a `spawnSync`
  timeout killed only the `cmd.exe` shim and left Codex as its orphan, the 2026-07-31 class. Its
  limit is `spawnSync`'s 1 MiB and an overflow settles with `ENOBUFS`, which the probe reads as
  inconclusive: a marker lost to a small buffer once refused a live sandbox.
- **One instrument answers "what changed in this worktree", and hooks never ask git directly.**
  `worktreeSnapshot()` in `src/home/lib/runner/git-state.mjs` is it: the run-folder prefix removed,
  gitignored paths absent by construction, `--no-renames` so every row is a real path rather than the
  token `old => new` that matches no scope pattern. Readers compose it the same way — `compareSnapshots`
  (the verdict through `runSnapshotChanges`), `splitRunChanges`, `outOfScope` — so the live witness and
  the final verdict cannot reach different answers about the same tree. `tests/hooks/tree-reader.test.mjs` fails any hook that spells
  `status --porcelain`, `ls-files -o` or `--numstat` in an argument list. Why: the witness kept its own
  porcelain reading and on 2026-09-19 ordered the orchestrator, on every tool call, to revert the run's
  own folder; the same blindness covered environment writes and gitignored notes, and the rename token
  would have failed an honest build for moving a file inside its scope.
- **A file name from git is taken only from `src/home/lib/runner/git-paths.mjs`, which spells every
  path-listing command whole, runs it with `-z` and decodes strictly.** Callers get arrays of exact
  names and never compose `ls-files`, `--name-only`, `--numstat`, `--porcelain` or `--stat` themselves;
  `tests/git-path-listing-guard.test.mjs` fails on any such literal elsewhere in `src`, `cli` or `bin`,
  except the three human-readable artifacts written with `core.quotepath=false` (`git-before.txt`,
  `git-after.txt`, `diff.stat`), which nothing parses. Names are exact: no trim, no quote stripping, no
  separator rewrite; a name that is not UTF-8 is refused, never replaced. The worktree snapshot is
  versioned (`src/home/lib/meta/snapshot-format.mjs`, `docs/artifact-formats.md`): the version comes
  from the header line only, and two snapshots of different versions are never compared — the verdict
  fails, the witness stays silent. Why: git quotes any non-ASCII name in its text output, and on
  2026-09-30 five callers that split that text themselves refused a vault's existing Cyrillic files at
  scope check, judged an honest in-scope edit out of scope and recorded a new Cyrillic file as size 0.
- **A service directory is defined once, `SERVICE_RE` in `src/home/lib/meta/paths.mjs`, and both the
  preflight scope check and the verdict import it.** The verdict fails every change under `.git/`,
  `.claude/`, `.codex/`, `.omx/`, `.omc/` and `node_modules/` whatever the scope says, except paths
  matched by `environmentPaths` (by default `.omc/**` and `.claude/settings.local.json`): `splitRunChanges`
  sets those aside as environment work before `outOfScope` runs; `structuralRefusal`
  in `src/home/lib/runner/scope-check.mjs` refuses a pattern inside one before the run folder exists. A
  glob that can also match ordinary files (`**/*.md`) is not refused. Why: on 2026-09-22 an order scoped
  to `.claude/context/architecture.md` passed preflight, worked 22 minutes, wrote every file correctly
  and was failed for that one — the gate and the judge were two measures of one tree.
- **`makeRunDir()` is the single registration boundary, and a refusal decided before it leaves nothing
  in the worktree.** Everything that can refuse without spending quota — bad arguments, an impossible
  scope, a detached tree, a chain that needs `--continue`, a dead sandbox, a busy tree, a missing Codex
  CLI — goes through `die()` before the folder exists, and exits 1 rather than the usage code 2 when the
  order was right and the host or the tree was not. Only two refusals stay after registration
  (`unsafeForCmd`, a worker that fails to spawn): by then the tree snapshot and the worker order are in
  the folder, so the folder explains itself. The busy and CLI checks live in
  `src/home/lib/runner/preflight.mjs`, and the attach / continuation / repeat decision in
  `src/home/lib/runner/pass-gate.mjs` (Plan_75 P0); neither is handed a run directory — a check added
  there cannot create one. `tests/runner/refusal-table.test.mjs` holds the table of all of them and fails when a
  refusal is added without a side and a reason. Why: on 2026-09-19 the busy refusal created its folder
  first, and in `~/.claude`, where run folders sit inside the worktree, the live writer's witness spent
  every tool call ordering the orchestrator to revert a directory the tool itself had made.
- **Orchestrator metadata in a task — `advice:`, `continue:`, `retry:` — exists only in the header at its top, and
  `src/home/lib/task-header.mjs` is its only reader** (Plan_75 D5). The runner (`args.mjs`, both task channels), the
  advice gate, the pass gate and the producer hook `order-gate.mjs` all take its result, parsed from the raw document
  before sections are extracted; a metadata-shaped line below the header is a free refusal, other prose is text. The
  task hash is the header-free body (`TASK_HASH_SCHEME` in `meta/chain.mjs`, recorded as `status.json#task_hash_scheme`);
  an owner without that field is never claimed to be "a different task" (`order-owner.mjs`). A new label is one
  descriptor in the module's registry, never another regex in a consumer. Why: on 2026-10-03 20:42 wrapped prose that
  began with `continue:` was obeyed as a grant, because grants, advice and the hash each had their own rule.
- **Every `cli/*.mjs` is reachable through static imports from the `package.json#bin` targets**, except the
  version-bound entries in `EXCEPTIONS` of `tests/cli-modules-reachable.test.mjs` (Plan_65 D13). A module whose last
  caller moved away is deleted in the same change, its still-needed assertions moved onto the live path first; a
  module written ahead of its wiring needs a plan decision for its exception, and the exception's `packageVersion`
  makes a release without the wiring fail the suite. Imports are read by Node's own parser
  (`vm.SourceTextModule#moduleRequests` under `--experimental-vm-modules`, `tests/module-requests.mjs`), never by
  regex. The guard proves structural reachability only: code still imported out of habit is review's job. Why: on
  2026-10-01 `removeImageFiles` lost its last caller to the removal plan and stayed green on its own test.
- **Whether a recorded process is still live is decided by the module that owns its record — a run by
  `src/home/lib/meta/run-liveness.mjs`, a lifecycle lock holder by `holderLiveness` in
  `cli/lifecycle-lock.mjs` (Plan_65 D11: its record is `acquiredAt`, read as `started_at` with the heartbeat
  ignored, never as `process_started_at`), and nobody else.** For runs,
  `src/home/lib/meta/run-liveness.mjs`. `runLiveness({ runDir, status })` requires the run folder and
  the record and returns the identity, the heartbeat age, the fail-open `processMayBeAlive` and the
  state closing the run would write (`running`, `unverified`, `abandoned`, `finished`);
  `workerMayBeAlive()` answers about the worker process whatever the record says, for the window in
  which the worker has closed `status.json` but not yet written `reply.txt`. Nothing else asks a
  process identity, re-exports one under another name, or declares a pid-first wrapper, and
  `tests/one-liveness-judge.test.mjs` fails the suite on all three: the wrappers' optional inputs
  are how the response guard came to judge by a bare pid and read a number reused after a reboot as
  a working run, while the project list never asked and printed `running` for a dead one.
