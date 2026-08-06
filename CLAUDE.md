# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this package is

`@lyupro/codex-bridge` installs three Claude Code dispatcher agents (`codex-scout`, `codex-build`,
`codex-review`), a delegating runner and three guard hooks into a Claude Code host, so
implementation work runs on a Codex CLI subscription instead of the Claude one.

Zero runtime dependencies, plain `.mjs` on the Node standard library, no build step — installing
from a clone must stay one command. Do not introduce dependencies or a compile stage.

## Commands

```bash
npm test                                   # whole suite (node --test) with an isolated Codex home
npm test -- tests/meta/verdict.test.mjs    # one file
npm test -- "tests/cli/*.test.mjs"         # one directory
npm run check:size                         # 400-line source-file gate, .file-size-limit.json
node bin/codex-bridge.mjs doctor           # what is installed on this host, is codex alive
npm run dev:install                        # update --force into ~/.claude from this clone
git config core.hooksPath .githooks        # enable the pre-commit size gate (once per clone)
```

**Never run `node --test` directly.** `scripts/run-tests.mjs` gives the suite a throwaway
`CODEX_HOME`; without it the installer tests drop `codex-bridge.rules` into the operator's real
`~/.codex/rules/`. `tests/home-isolation.test.mjs` fails loudly if that isolation is missing.

## Architecture

Two independent halves share the repository:

**Package/installer** — `bin/codex-bridge.mjs` (argument dispatch only) over `cli/`:
`manifest.mjs` owns the install table, the seeded-file list and the `.codex-bridge-install.json`
record schema; `install/update/uninstall/doctor.mjs` are one command each, as are the run-store
commands `read` (renders one run), `projects` (inventory over `runs-inventory`/`table`) and `prune`
(`prune-args` refuses, `prune-plan` decides, `prune.mjs` deletes); `hosts.mjs` resolves host
paths without touching disk; `settings-merge.mjs` registers the hooks without destroying foreign
ones, and finds its own by command rather than by matcher — the matcher is generated from a tool
list and changes whenever a host spelling is added. `update` compares sha256 fingerprints from the record: outdated files refresh silently,
hand-edited files stop the run unless `--force`.

**Runtime runner** — `src/`, installed into the host's `agents/codex/`:

- `run-codex.mjs` is the command line and the fork between two programs. A plain call is the
  **launcher** (`runner/launcher.mjs`): every refusal that costs no quota happens here, before the
  detached **worker** (`runner/worker.mjs`) is spawned. The split exists because the calling shell
  dies long before a 20-minute run does; the worker closes the run with artifacts either way.
- `runner/` is one concern per module: `run-context` holds the run in progress, `run-env` reads
  `run-config.json`, `args` refuses the command line, `schemas`/`prompts` are what each agent is
  asked for, `git-state` snapshots the tree, `codex-cmd` invokes the CLI, `project-dir`/`runs-root`
  place the artifacts.
- `write-meta.mjs` is the only reader of a finished run's artifacts. `meta/` splits it: `paths`
  (artifact reads and path matching), `chain` (earlier passes of the same task), `run-state`
  (`status.json` honesty, abandoned runs), `events` (the JSONL stream — the only module that knows
  it is JSONL), `startup` (a run that never began), `transport`/`deadline`/`outcome` (damaged
  evidence, killed runs, the declared outcome), `verdict` (OK/FAIL/LIMIT), `reply` (printed lines).
- `hooks/` holds the four guards, all fail-open on anything they do not recognise:
  `reply-guard.mjs` (SubagentStop) rejects a dispatcher reply that `meta.json` does not support or
  that stays silent about a live `codex-build` run of the same project; `order-gate.mjs`
  (PreToolUse) refuses a dispatcher call whose task text names no order id; `worktree-lock.mjs`
  (PreToolUse) refuses a file edit inside a repository a live `codex-build` run holds;
  `prune-guard.mjs` (PreToolUse) refuses an agent-issued `codex-bridge prune`, matching the command
  line by spelling — so a new CLI name has to be added here too, or the alias walks past it.
  `live-runs.mjs` is the one answer to "is this run alive" the guards ask.
- `retention.mjs` owns the list of transport files and the age rule, because `cli/` is not copied
  into the host and the runner could not import the pruning planner otherwise.

Importers name `run-codex.mjs` and `write-meta.mjs`, never a module below them.

## Contracts that break silently if you touch them carelessly

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
  `run-config.json` — otherwise one run gets two different configurations. See
  `docs/worker-contract.md`.
- **`src/run-config.json` is seeded, never overwritten.** It is the host's file (models, effort,
  `environmentPaths`), like a `.env`. `SEEDED_SOURCES` in `cli/manifest.mjs`.
- **`codex-runs/` is user data.** Uninstall never touches it; the install record is forbidden from
  naming it.
- **Model ids live only in `run-config.json`.** No model literal belongs in `.mjs` code.
- **Windows paths are compared normalized** (forward slashes, no trailing slash, case-insensitive)
  and symlinks are deliberately not resolved: `realpath` returns `\\?\` and UNC forms.
- **Agent and command markdown is placeholder-processed** on install: `{{CODEX_BRIDGE_DIR}}` becomes
  the host's `agents/codex/`. Keep the placeholder, never a real path.

## Repository conventions

- **400 lines per source file**, enforced by `scripts/check-file-size.mjs` at pre-commit. An entry
  in `.file-size-limit.json#exclude` naming a specific file requires an `exclusionRationale`. Split
  by responsibility, not by moving lines into a `utils.mjs`.
- **Code, comments, prompts, README and CHANGELOG are English. `docs/` is Russian.** Follow whatever
  the file you are editing already uses.
- **Comments explain why, with the incident behind the rule.** The existing headers cite the run
  that failed; match that density instead of restating what the code does.
- Every closed step gets an operator checklist in `docs/checklists/` and a link from
  `docs/operator-checklists.md` — `tests/docs-checklist-index.test.mjs` fails if either side is
  missing. Fully passed checklists move to `docs/checklists/done/`.
- `docs/plans/` records why the code is shaped this way, what was rejected and at what cost. Read
  the relevant plan before redesigning a mechanism.
- Tests mirror source layout (`tests/meta/`, `tests/runner/`, `tests/cli/`); shared fixtures live in
  `tests/meta/test-fixtures.mjs`.

## Where the answer already is

| Question | File |
| --- | --- |
| How a run proceeds, refusal points, abandoned runs | `docs/run-lifecycle.md` |
| Why a status came out OK/FAIL/LIMIT | `docs/verdict.md` |
| What launcher hands the worker | `docs/worker-contract.md` |
| Shape of `status.json` and `meta.json` | `docs/artifact-formats.md` |
| Agents, flags, config keys, artifacts (full, Russian) | `docs/overview.ru.md` |
