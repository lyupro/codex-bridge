# codex-bridge

**Delegate implementation, reconnaissance and review from Claude Code to Codex — six host guards, zero runtime dependencies, zero build steps.**

[![npm version](https://img.shields.io/npm/v/@lyupro/codex-bridge)](https://www.npmjs.com/package/@lyupro/codex-bridge)
[![Node.js](https://img.shields.io/node/v/@lyupro/codex-bridge)](https://www.npmjs.com/package/@lyupro/codex-bridge)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[![npm downloads](https://img.shields.io/npm/dm/@lyupro/codex-bridge)](https://www.npmjs.com/package/@lyupro/codex-bridge)
[![npm unpacked size](https://img.shields.io/npm/unpacked-size/@lyupro/codex-bridge)](https://www.npmjs.com/package/@lyupro/codex-bridge)
[![dependencies: zero](https://img.shields.io/badge/dependencies-zero-brightgreen)](package.json)

Agentic coding spends one model subscription on everything, and implementation is the expensive part. codex-bridge moves that work to a separate [Codex CLI](https://developers.openai.com/codex/cli) subscription: Claude Code plans, dispatches and accepts, Codex executes — and every delegated run is guarded, verified and audited on disk.

## Install

```bash
npm i -g @lyupro/codex-bridge   # puts both command names on PATH
codex-bridge install            # into ~/.claude and ~/.lyupro/.codex-bridge/
codexb install                  # the short name, same command
```

Two other entry points reach the same command: `npx @lyupro/codex-bridge install` for a one-off run without a global install, and `node bin/codex-bridge.mjs install` from a clone. Every command below works through all three.

Shipped agents invoke delegated runs through `codex-bridge run`. This is a permission contract,
not a style choice: the stable package command lets host permission rules match the invocation
without exposing an installation-specific absolute path and prompting on every delegation.

Use `--scope project` to install the Claude Code-facing files under `<repo>/.claude`; the default user scope uses `~/.claude`.

Installation has two roots:

- `~/.lyupro/.codex-bridge/` contains package runtime files, guards, configuration, conventions, and the installation record.
- The selected Claude Code root (`~/.claude/` or `<repo>/.claude/`) contains the three agents, two slash commands, merged hook registrations in `settings.json`, and run artifacts under `codex-runs/`.

The repository's `src/home/` directory is the literal image copied into the branded root: its
`hooks/`, `lib/`, `config.json`, and `conventions.md` paths are the host paths without remapping.
Only npm's `package.json` is copied into that root from outside the image.

Before every `settings.json` write, the existing file is backed up. Existing settings and foreign hooks are preserved. `--dry-run` prints the plan without writing.

If a global install and a clone coexist, you have two package copies. `codex-bridge update`, `codexb update`, and the clone entry point copy files from whichever copy launched the command; using the wrong one can replace a newer host installation with older files.

`codex-runs/` contains operator data. Uninstall never removes it.

## Requirements

- Node.js >= 24
- An authenticated [Codex CLI](https://developers.openai.com/codex/cli): `codex --version` and `codex login`
- Claude Code, which hosts the agents, commands, and guards

## What it gives you

- **Runs survive the caller.** A detached worker keeps the run and its artifacts alive after the dispatcher exits.
- **Invalid work is rejected before quota is spent.** Scope, order, retry, branch, and continuation checks run before a run folder is created.
- **Verdicts come from artifacts.** CLI events, git state, and the declared report decide the result, not model claims about itself.
- **Identical retries attach safely.** Repeating the same command joins the active run instead of starting another one.
- **6 host guards enforce the boundary.** `reply-guard`, `order-gate`, `worktree-lock`, `prune-guard`, and `stop-guard` cover replies, orders, edits, deletion, and stopping; `worktree-witness` stands behind the lock and names a write that reached the tree anyway.
- **Installation is identifiable and reversible.** Writes to `settings.json` are merged and backed up; uninstall removes recorded package files only.
- **Every run leaves an audit folder.** The verbatim task, scope, before/after git state, events, report, verdict, and reason remain together.
- **Zero runtime dependencies and zero build steps.** The package is plain `.mjs` on the Node.js standard library.

The current suite contains **804 automated tests: 803 passing and 1 skipped**.

## Verify

```bash
codex-bridge doctor
```

Output on a healthy host (trimmed):

```text
[ok] host: ~/.claude (user, exists)
[ok] installation: @lyupro/codex-bridge@0.5.1 (matches package)
[ok] files: 53 installed file(s) present
[ok] rules: ~/.codex/rules/codex-bridge.rules (matches record)
[ok] permissions: installed (24/24 own strings in allow/deny)
[ok] hook:SubagentStop: matcher * -> ~/.lyupro/.codex-bridge/hooks/reply-guard.mjs
[ok] hook:PreToolUse: matcher Agent|Task -> ~/.lyupro/.codex-bridge/hooks/order-gate.mjs
[ok] hook:PreToolUse: matcher Write|Edit|MultiEdit|NotebookEdit -> ~/.lyupro/.codex-bridge/hooks/worktree-lock.mjs
[ok] hook:PreToolUse: matcher Bash|PowerShell -> ~/.lyupro/.codex-bridge/hooks/prune-guard.mjs
[ok] hook:PreToolUse: matcher TaskStop -> ~/.lyupro/.codex-bridge/hooks/stop-guard.mjs
[warn] retention: Automatic cleanup is ON — run transport older than 30 days is removed to reclaim disk space.
[ok] conventions: ~/.lyupro/.codex-bridge/conventions.md (found)
[ok] codex: codex-cli 0.146.1
[ok] node: 24.18.0 (requires >=24)
[ok] runsRoot: ~/.claude/codex-runs
[ok] liveRuns: 0 runs working right now
```

`doctor` reports the selected host, package source, installed files and guards, Codex availability, retention policy, permissions, live runs, and the current repository's run folder. The `agents` line is a read, not a file count: each installed definition is parsed and its `name` checked against the dispatcher it claims to be, because a definition the host cannot read is a dispatcher that does not exist while every other line still says `[ok]`. Content that drifts from the packaged definition is a failure, not a warning: `doctor` exits 1 and names `codex-bridge update --force`, because a host running someone else's agent files may be calling the runner in a form no permission rule matches.

If a session answers `Agent type 'codex-build' not found`, a run can still be started without the dispatcher — the agent is a wrapper that types one command:

```bash
codex-bridge run --agent codex-build --repo <repository> --order-id <id> --scope <globs> --task-file <absolute path>
```

The trade-off is explicit: `order-gate` and `reply-guard` sit on the dispatcher call, so a direct run is unguarded and its result is judged by the worktree and the suite.

## Update

Update the global package, then refresh the selected host installation:

```bash
npm i -g @lyupro/codex-bridge
codex-bridge update
```

`update` refreshes unchanged package files, refuses to overwrite operator edits unless `--force` is supplied, and removes obsolete files only when their installed fingerprint is unchanged.

## Limitations

- **Runs are not isolated from one another.** They share one worktree; guards prevent concurrent writers instead of creating sandboxes.
- **A build run has a 25-minute deadline.** Work and artifacts survive a timeout, but the run may need an explicit continuation.
- **A dispatcher verdict is not the work outcome.** Judge completion from the worktree and tests as well as the recorded verdict.

Transport files from runs at least **30 days** old are pruned automatically when a new run starts. Configuration can change or disable that retention policy; reports, accounting, and worktree snapshots are retained.

## Command reference

| Command | Purpose |
| --- | --- |
| `install [--scope user\|project] [--host <path>] [--dry-run] [--force]` | Install into a Claude Code host. |
| `update [--scope user\|project] [--host <path>] [--dry-run] [--force]` | Refresh a recorded installation. |
| `permissions [add\|remove] [--scope user\|project] [--host <path>]` | Inspect or manage optional shell rules. |
| `uninstall [--scope user\|project] [--host <path>] [--dry-run]` | Remove recorded package files while preserving run artifacts. |
| `doctor [--scope user\|project] [--host <path>]` | Diagnose the selected host and Codex connection. |
| `run <runner options> --task-file <abs path>` | Start or attach to a delegated run through the permission-stable package command. The task file carries the statement, the scout questions and the verification command; its path must be absolute. Piping the statement on stdin is the alternative channel, and the two cannot be combined. |
| `projects [<name>] [--json]` | List projects or runs in the run store. |
| `prune <project> [<run>] [--purge] [--older-than <age>] [-f] [--json]` | Plan or perform operator-confirmed cleanup. |
| `unlock [<project>\|--all]` | Close records whose runner is gone. |
| `read <run>` | Render a run's structured event stream. |
| `stop <run>` | Stop a run and record a `FAIL` verdict. |

Both `codex-bridge` and `codexb` invoke the same command. Run `codex-bridge --help` for exact forms.

### Development

```bash
git clone https://github.com/lyupro/codex-bridge.git
cd codex-bridge
git config core.hooksPath .githooks
npm test
```

The Git hook enforces the 400-line source-file limit.

## License

[MIT](LICENSE)
