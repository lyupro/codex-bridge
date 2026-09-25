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
  evidence, killed runs, the declared outcome), `verdict` (OK/FAIL/LIMIT), `reply` (printed lines),
  `launch-rows` (rows from what the launcher recorded in `status.json` — retention, an inconclusive
  sandbox probe — applied once in `collect()` and once in `writeFailure()`, because the retention row
  once lived in five reply functions and was missing from the sixth path), `run-liveness` (the one
  judge of a recorded run: identity, heartbeat age, the fail-open `processMayBeAlive`, and the state
  closing it would write — `running`/`unverified`/`abandoned`/`finished`; it requires the run folder,
  because the reply guard once asked with a bare pid and read a reused number as a live run, Plan_57
  D27). The advisor path uses `meta/advisor-task.mjs` (task parser), `meta/advice-verdict.mjs`
  (pure judge), and `meta/advice-status.mjs` (run-folder adapter); `runner/advise-carry.mjs` takes the
  one snapshot of the scope result that both the advise prompt and the judge read (Plan_59 D22 — on
  2026-09-23 the judge read the scope folder while the prompt was handed nothing).
- `hooks/` holds the seven guards (`stop-guard` and `worktree-witness` beside those below). All fail
  open on anything they do not recognise except the dispatcher gate, which fails closed for a
  dispatcher whose order it cannot read (Plan_62 D7):
  `reply-guard.mjs` (SubagentStop) rejects a dispatcher reply that `meta.json` does not support or
  that stays silent about a live `codex-build` run of the same project; `order-gate.mjs`
  (PreToolUse) refuses a dispatcher call whose task text names no order id; `worktree-lock.mjs`
  (PreToolUse) refuses a file edit inside a repository a live `codex-build` run holds;
  `prune-guard.mjs` (PreToolUse) refuses an agent-issued `codex-bridge prune`, matching the command
  line by spelling — so a new CLI name has to be added here too, or the alias walks past it.
  `dispatcher-gate.mjs` (PreToolUse on the shell tools and `SubagentHandback`, PostToolUse/Failure on
  the shell tools; decisions in `lib/dispatcher-gate.mjs`) lets a dispatcher run only the one
  `codex-bridge run` command its order yields and replaces its handback with the runner's stdout
  (Plan_62 D3/D8); the order comes from the first line of the dispatcher's own transcript
  (`lib/dispatcher-order.mjs`, D7). `reply-guard` yields after a handback and audits that every tool call
  passed the gate (`lib/dispatcher-stop.mjs`, D13/D15). The tool list the gate is registered on is
  `DISPATCHER_TOOLS` in `lib/hook-definitions.mjs` — one spelling of the handback tool.
- `state/` under the brand root is the package's only mutable state (Plan_62 D14): dispatcher state,
  the handback witness, the dispatcher contract record, guard counters and diagnostics. Its path comes
  only from `brandStateDir`/`BRAND_STATE_DIR` in `brand-home.mjs`.
- **Installer is the package, execution is the home** (Plan_62 D17). `cli/hook.mjs` and
  `cli/run-launcher.mjs` are launchers: they resolve the brand home and import `lib/hook-entry.mjs` or the
  installed runner, never the package copy beside them — on 2026-09-24 a clone registered hook names the
  global 0.6.6 did not know and every shell call on the machine was refused. `cli/launcher-probe.mjs`
  (`hook --home`) decides whether the short command form may be registered at all.
- `cli/probe-contract.mjs` + `cli/probe-rig.mjs` run the one paid host session behind
  `doctor --probe-contract`; `cli/host-contract.mjs` judges the refusal contract,
  `cli/dispatcher-contract.mjs` the four dispatcher contracts, `cli/dispatcher-contract-record.mjs` keeps
  their verdicts in `state/dispatcher-contract.json` (D19). Both records are keyed by host version.
- **The judged host is the one sessions ran on, named by its transcript** (Plan_66). `lib/host-version.mjs`
  reads the `version` the host writes into its own transcript; `lib/host-observations.mjs` records it once
  per session from the gate, before its dispatcher filter (`state/host-observations.json`).
  `cli/session-hosts.mjs` turns observations into the current host and `otherHost:*` lines for `doctor`
  and `install`; `cli/probe-target.mjs` picks the executable `--probe-contract` measures. Never identify
  the host by `claude` on PATH or by `CLAUDE_CODE_EXECPATH`/`CLAUDE_AGENT_SDK_VERSION`: on 2026-09-25 the
  VS Code extension 2.1.282 ran the sessions beside PATH 2.1.281, and those variables proved inherited by
  every descendant `claude`.
- `live-runs.mjs` is the one answer to "is this run live" the guards ask — the judgment of
  `meta/run-liveness.mjs` plus a fresh heartbeat. `meta/run-state.mjs` deliberately uses the judgment
  without the heartbeat; the comment there says why merging the two broke both.
- `heartbeat.mjs` stamps that a run is *moving*, not that a process exists: a worker outliving its
  Codex kept a repository locked for seven minutes on 2026-08-06. Guards require it; the modules
  that close records or refuse a second writing run do not.
- `no-self-execution.mjs` is the first block of all four agent prompts, rendered through
  `{{CODEX_NO_SELF_EXECUTION}}`. One copy, because a dispatcher that could not start its run once
  did the work itself on the Claude quota.
- `retention.mjs` owns the list of transport files and the age rule, because `cli/` is not copied
  into the host and the runner could not import the pruning planner otherwise.

Importers name `run-codex.mjs` and `write-meta.mjs`, never a module below them.

