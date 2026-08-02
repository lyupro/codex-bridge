# codex-bridge

Delegate implementation, reconnaissance and code review from Claude Code to the
[Codex CLI](https://developers.openai.com/codex/cli), so the work runs on a Codex
subscription instead of the Claude one.

> **Status: extraction in progress.** The runner and its dispatchers already work — they
> are being moved here from a working installation, one stage at a time. The installer
> (`codex-bridge install`) does not exist yet, so this repository cannot be installed as a
> package today. See `docs/plans/` for the order of the remaining stages.

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
