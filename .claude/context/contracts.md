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
