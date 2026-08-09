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

Two halves share the repository: the **package/installer** (`bin/`, `cli/`) and the **runtime
runner** (`src/`, installed into the host's `agents/codex/`). Which module owns what, why the
launcher/worker split exists and which incident shaped each boundary is in
[`.claude/context/architecture.md`](.claude/context/architecture.md).

**Editing anything under `src/` or `cli/`, adding a module, or answering where something lives —
read that file BEFORE the first edit, not from memory.**
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
- **`src/cli-names.mjs` is the only list of CLI spellings.** `bin`, the prune guard's matcher and
  anything else that has to recognise a call read it from there. Two independent lists drift
  silently — exactly how the installer and test hook lists had already drifted before Plan_19.
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
