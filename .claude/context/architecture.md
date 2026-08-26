# Architecture — codex-bridge

Вырезано из `CLAUDE.md` 2026-08-10 дословно (Plan_30): раздел нужен при работе в `src/` и `cli/`,
а грузился каждую сессию. Роутер, который сюда ведёт, стоит в `CLAUDE.md`.

## Architecture

Two independent halves share the repository:

**Package/installer** — `bin/codex-bridge.mjs` (argument dispatch only), reachable as both
`codex-bridge` and the short `codexb`, over `cli/`:
`manifest.mjs` owns the install table, the seeded-file list and the `.codex-bridge-install.json`
record schema; `install/update/uninstall/doctor.mjs` are one command each, as are the run-store
commands `read` (renders one run), `projects` (inventory over `runs-inventory`/`table`), `prune`
(`prune-args` refuses, `prune-plan` decides, `prune.mjs` deletes) and `unlock` (closes running
records whose pid is dead or foreign, deletes nothing, never touches an alive pid); `hosts.mjs` resolves host
paths without touching disk; `settings-merge.mjs` registers the hooks without destroying foreign
ones, and finds its own by command rather than by matcher — the matcher is generated from a tool
list and changes whenever a host spelling is added. `update` compares sha256 fingerprints from the record: outdated files refresh silently,
hand-edited files stop the run unless `--force`.

**Runtime runner** — `src/`, installed into `~/.lyupro/.codex-bridge/lib/` (the guards into
`hooks/` beside it); only the agent and command markdown goes to the host's
`agents/codex-bridge/` and `commands/codex-bridge/`, because Claude Code reads those nowhere else:

- `run-codex.mjs` is the command line and the fork between two programs. A plain call is the
  **launcher** (`runner/launcher.mjs`): every refusal that costs no quota happens here, before the
  detached **worker** (`runner/worker.mjs`) is spawned. The split exists because the calling shell
  dies long before a 20-minute run does; the worker closes the run with artifacts either way.
- `brand-home.mjs` answers one question for both halves of the repository: where the host-side files
  live (`CODEX_BRIDGE_HOME`, else `~/.lyupro/.codex-bridge/`) and whether that answer came from the
  override or the default. `run-config.mjs` and `cli/hosts.mjs` ask it; nothing derives that path
  from its own module location any more.
- `runner/` is one concern per module: `run-context` holds the run in progress, `run-env` reads
  `run-config.json`, `args` refuses the command line, `schemas`/`prompts` are what each agent is
  asked for, `git-state` snapshots the tree, `codex-args` decides what Codex is asked to run — model,
  reasoning depth and the flag set per agent, with `sandbox-flags` naming what the platform needs
  before a sandboxed process can start at all — while `codex-cmd` starts and stops that process and
  knows nothing about the arguments' meaning; `worker-order` writes the launcher's order into
  worker.json, `project-dir`/`runs-root` place the artifacts, `conventions` pastes the rules a run is judged by into `task.md` — the
  seeded host-wide `conventions.md` and the worked repository's optional `.codex-conventions.md`,
  verbatim under one heading, because "read file X" is hope and a run is free not to.
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
  `live-runs.mjs` is the one answer to "is this run alive" the guards ask — pid plus a fresh
  heartbeat. `meta/run-state.mjs` deliberately answers it by pid alone; the comment there says why
  merging the two broke both.
- `heartbeat.mjs` stamps that a run is *moving*, not that a process exists: a worker outliving its
  Codex kept a repository locked for seven minutes on 2026-08-06. Guards require it; the modules
  that close records or refuse a second writing run do not.
- `no-self-execution.mjs` is the first block of all three agent prompts, rendered through
  `{{CODEX_NO_SELF_EXECUTION}}`. One copy, because a dispatcher that could not start its run once
  did the work itself on the Claude quota.
- `retention.mjs` owns the list of transport files and the age rule, because `cli/` is not copied
  into the host and the runner could not import the pruning planner otherwise.

Importers name `run-codex.mjs` and `write-meta.mjs`, never a module below them.

