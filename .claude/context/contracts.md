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
