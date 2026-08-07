# codex-bridge

Delegate implementation, reconnaissance and code review from Claude Code to the
[Codex CLI](https://developers.openai.com/codex/cli), so the work runs on a Codex
subscription instead of the Claude one.

## Install

```bash
npx @lyupro/codex-bridge install        # one-off, into ~/.claude
npm i -g @lyupro/codex-bridge           # install both command names globally
codex-bridge install                    # full name, from any directory
codexb install                          # short name, same command
node bin/codex-bridge.mjs install       # from a clone, same thing
node bin/codex-bridge.mjs install --scope project   # into <repo>/.claude
node bin/codex-bridge.mjs update        # bring an installation up to the current version
node bin/codex-bridge.mjs doctor        # what is installed, where it points, is codex alive
node bin/codex-bridge.mjs uninstall     # removes exactly what was installed
node bin/codex-bridge.mjs stop <run>    # close a hanging run by hand, without hunting for a pid
node bin/codex-bridge.mjs read <run>   # read a run: its events rendered as text, on demand
node bin/codex-bridge.mjs projects     # what the run store holds: projects, runs, weight, tokens
node bin/codex-bridge.mjs prune <project>   # reclaim disk space, transport only unless told otherwise
node bin/codex-bridge.mjs sweep [<project>] # close running records whose runner is gone
```

When a global install and a clone coexist, there are two copies of the package. `codex-bridge update`
and `codexb update` copy host files from whichever copy launched the command, so `codexb update`
from `PATH` can silently revert a host that `npm run dev:install` from the clone just updated.

`install` copies the package into the host's `agents/codex/`, its slash commands into
`commands/codex/`, and registers its four hooks in `settings.json` — **merged**, so hooks that
are already there survive, and the file is backed up before every write. Run it twice and the
second run does nothing. `--dry-run` prints the plan and touches nothing.

`update` moves an existing installation to the current version. It knows the sha256 of every file
as it was installed, so it can tell a file you edited on the host from one left over by an older
version: outdated files are refreshed silently, files you changed by hand stop the run and are
named, and `--force` is what overwrites them. A file the package no longer ships is removed only
if you never touched it.

`uninstall` removes only what the install recorded: a file you put in `agents/codex/` yourself
stays, and `codex-runs/` is never touched — those are your run artifacts, not the package.

`stop` takes a run folder — a full path or a bare name from the current project's runs directory —
kills that run's whole process tree and closes the folder the way an abandoned run is closed: a
`FAIL` verdict naming what the run left in the worktree. A run that already has a verdict is left
alone. Runs end on their own time budget now, so this is for the case where something wedged
anyway.

Run artifacts live in `codex-runs/<project>/`, one folder per repository, marked with a
`.project.json` holding that repository's path. Two checkouts that share a directory name — two
different `api` — therefore get `api` and `api-2` instead of one mixed history. `doctor` prints
which folder the current repository writes to.

`projects` reads that store back: without an argument, one line per project — runs, weight, tokens
spent, how many are running right now; with a project name, one line per run. `prune` is the only
command in the package that destroys data, and it is built to be hard to fire by accident: without
`-f` it prints a plan and deletes nothing, `-f` still asks before each step, and with no terminal
it refuses outright, because deletion is an operator action and there is no flag around it.
By default it removes transport only — event streams and stderr, the megabytes — and leaves
accounting, reports and worktree snapshots alone; `--purge` is what takes a folder whole.
The same transport is dropped automatically from runs older than 30 days when a new run starts,
which the reply says out loud; `retention` in `run-config.json` changes the age or turns it off.

`sweep` is housekeeping for records left by a dead runner. With no project it scans the whole
store; with one project it limits the scan to that folder. It uses the same dead-pid decision as
start-of-run cleanup, never closes a live pid even when its heartbeat is stale, and never deletes
run artifacts. A stale live-pid record is named with the exact `codex-bridge stop <run>` command
needed to close it.

## What it gives you

- **Three dispatcher agents** for Claude Code — reconnaissance (read-only), implementation
  (write access limited to a declared scope), and an independent review by a second model.
- **A runner that survives a dropped call.** The launcher hands the run to a detached
  worker, so a killed dispatcher no longer leaves the work unexplainable: the run folder is
  closed with artifacts either way.
- **A verdict that checks the report against the worktree.** The agent's own account of what
  it changed is compared with what git says actually changed, and a mismatch is a failed run
  rather than a nicer-sounding summary.
- **Four hooks that hold the rules the prompts only ask for**: a reply is refused when it does not
  match the recorded state of the run, a dispatcher call is refused when it carries no order id, a
  file edit is refused inside a repository a live run holds, and deletion of the run store is
  refused when an agent is the one asking.

## Requirements

- Node.js >= 24 (the file-size gate uses `fs.glob`, the test runner uses directory globs)
- The `codex` CLI, authenticated (`codex --version`, `codex login`)
- Claude Code, for the agents and the hook to be registered in

No runtime dependencies: everything here is plain `.mjs` on the Node standard library, and
that is deliberate — installing from a clone stays one command, with no build step.

## Development

```bash
git clone https://github.com/lyupro/codex-bridge.git
cd codex-bridge
git config core.hooksPath .githooks   # pre-commit file-size gate, 400 lines per source file
npm test                              # node --test, no dependencies to install
```

## License

MIT
