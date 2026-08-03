---
description: Show or switch the environment of delegated Codex runs — the operator's hooks and plugins
allowed-tools: Bash
argument-hint: "[hooks|plugins on|off] | [reset]"
---

<!-- Part of the agents/codex/ package. The file lives here out of necessity: the slash command name
     is set by its location under commands/<namespace>/, and Claude Code understands neither
     symlinks nor pointer files (verified 2026-08-02). Edit it here; it travels as a copy when the
     package is installed. -->

Environment switches for `codex-scout` / `codex-build` / `codex-review` runs. By default the hooks
and plugins from `~/.codex` do not reach a delegated run: they are written for interactive work and
do harm in an automated one — the failing `Stop` hook of `oh-my-codex` would not let Codex leave the
session, and instead of doing the task it quarantined `.omx/state/session.json`. The operator's
interactive Codex is untouched: the flags are set on one specific runner invocation,
`~/.codex/hooks.json` is not modified.

Run exactly this command, substituting the user's arguments (`$ARGUMENTS`), and return its output
verbatim. Add nothing and recompute nothing:

```bash
node "{{CODEX_BRIDGE_DIR}}/run-config.mjs" $ARGUMENTS
```

Call forms:

- no arguments — show the current state and the path to the file;
- `hooks on` / `hooks off` — bring back or remove the operator's hooks;
- `plugins on` / `plugins off` — the same for plugins;
- `reset` — back to the default (both off).

The state lives in `agents/codex/run-config.json` and lands in the `meta.json` of every run, so the
artifacts always show which environment a run went through.

If the user turns `hooks` on, say in one line: while the failing `Stop` hook of `oh-my-codex` stays
in `~/.codex/hooks.json`, runs will again spend quota on unrelated repairs. Checking the report
against the tree will fail such a run, but the quota is already gone.
