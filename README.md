# codex-bridge

Delegate implementation, reconnaissance and code review from Claude Code to the
[Codex CLI](https://developers.openai.com/codex/cli), so the work runs on a Codex
subscription instead of the Claude one.

> **Status: extraction in progress.** The runner, the dispatchers and the installer work and
> are covered by tests, but the package has not been published to npm yet and its prompts are
> still in Russian. See `docs/plans/` for the remaining stages.

## Install

```bash
npx @lyupro/codex-bridge install        # into ~/.claude          (not published yet)
node bin/codex-bridge.mjs install       # from a clone, same thing
node bin/codex-bridge.mjs install --scope project   # into <repo>/.claude
node bin/codex-bridge.mjs update        # bring an installation up to the current version
node bin/codex-bridge.mjs doctor        # what is installed, where it points, is codex alive
node bin/codex-bridge.mjs uninstall     # removes exactly what was installed
```

`install` copies the package into the host's `agents/codex/`, its slash commands into
`commands/codex/`, and registers the stop hook in `settings.json` — **merged**, so hooks that
are already there survive, and the file is backed up before every write. Run it twice and the
second run does nothing. `--dry-run` prints the plan and touches nothing.

`update` moves an existing installation to the current version. It knows the sha256 of every file
as it was installed, so it can tell a file you edited on the host from one left over by an older
version: outdated files are refreshed silently, files you changed by hand stop the run and are
named, and `--force` is what overwrites them. A file the package no longer ships is removed only
if you never touched it.

`uninstall` removes only what the install recorded: a file you put in `agents/codex/` yourself
stays, and `codex-runs/` is never touched — those are your run artifacts, not the package.

Run artifacts live in `codex-runs/<project>/`, one folder per repository, marked with a
`.project.json` holding that repository's path. Two checkouts that share a directory name — two
different `api` — therefore get `api` and `api-2` instead of one mixed history. `doctor` prints
which folder the current repository writes to.

## What it gives you

- **Three dispatcher agents** for Claude Code — reconnaissance (read-only), implementation
  (write access limited to a declared scope), and an independent review by a second model.
- **A runner that survives a dropped call.** The launcher hands the run to a detached
  worker, so a killed dispatcher no longer leaves the work unexplainable: the run folder is
  closed with artifacts either way.
- **A verdict that checks the report against the worktree.** The agent's own account of what
  it changed is compared with what git says actually changed, and a mismatch is a failed run
  rather than a nicer-sounding summary.
- **A stop hook** that refuses a dispatcher reply which does not match the recorded state of
  the run.

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
