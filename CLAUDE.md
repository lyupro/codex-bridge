# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this package is

`@lyupro/codex-bridge` installs three Claude Code dispatcher agents (`codex-scout`, `codex-build`,
`codex-review`), a delegating runner and five guard hooks into a Claude Code host, so
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

Two halves share the repository: the **package/installer** (`bin/`, `cli/`) and the literal
**installed home image** (`src/home/`, copied one-to-one into `~/.lyupro/.codex-bridge/`; runner
modules are under `lib/`). Which module owns what, why the
launcher/worker split exists and which incident shaped each boundary is in
[`.claude/context/architecture.md`](.claude/context/architecture.md).

**Editing anything under `src/` or `cli/`, adding a module, or answering where something lives —
read that file BEFORE the first edit, not from memory.**

## Contracts that break silently

**Touching any of the following → you are OBLIGED to read
[`.claude/context/contracts.md`](.claude/context/contracts.md) BEFORE the first edit, not from
memory:**

| Trigger | Why |
| --- | --- |
| `meta/` — verdict, status, events, `LIMIT` | check order is the contract; a run once quoted "rate limit" from a source file and threw away finished work |
| `runner/`, `launcher.mjs`, `worker.mjs`, `worker.json` | write order and the worker's single source of orders |
| `src/home/config.json`, any model id, any env or config key | seeded, never overwritten; no model literal belongs in `.mjs` |
| `cli/install.mjs`, `cli/uninstall.mjs`, `cli/manifest.mjs`, permission rules | install grants the rules in the scope it installed into |
| `agents/**`, dispatcher prompts, `hooks/order-gate.mjs`, anything that builds a command line | one line, `codex-bridge run`, never by path, no free text |
| Path comparison, `cli/invoked-directly.mjs` | Windows paths are compared normalized, symlinks deliberately unresolved |
| `src/home/lib/cli-names.mjs`, `codex-runs/`, prune | one list of spellings; run artifacts are user data |

Adding a rule to that file is fine; restating one here is not — two copies drift, which is the exact
defect Plan_46 was written about.

## Repository conventions

- **400 lines per source file**, enforced by `scripts/check-file-size.mjs` at pre-commit. An entry
  in `.file-size-limit.json#exclude` naming a specific file requires an `exclusionRationale`. Split
  by responsibility, not by moving lines into a `utils.mjs`.
- **Everything tracked in this repository is English** — code, comments, prompts, README, CHANGELOG
  and the reference documents in `docs/`. The untracked working notes below stay Russian.
- **Comments explain why, with the incident behind the rule.** The existing headers cite the run
  that failed; match that density instead of restating what the code does.
- **Three folders are kept on disk and out of git** (Plan_36, `.gitignore`): `docs/plans/`,
  `docs/checklists/` and `docs/audits/`. They are still written in full and still Russian — they are
  the only memory between sessions — but they are the workroom, not the storefront, and a fresh
  clone does not contain them. **A step is closed by a commit plus a plan entry plus a checklist;
  only the commit is visible in git.**
- Every closed step gets an operator checklist in `docs/checklists/` and a link from
  `docs/checklists/operator-checklists.md` — `tests/docs-checklist-index.test.mjs` enforces both
  sides wherever the folder exists, and skips where it does not. Fully passed checklists move to
  `docs/checklists/done/`.
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
| Agents, flags, config keys, artifacts | `docs/overview.md` |
