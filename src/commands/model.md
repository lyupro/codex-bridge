---
description: Show which model and reasoning depth each delegated Codex role runs on, or list the live catalogue
allowed-tools: Bash
argument-hint: "[list]"
---

<!-- Part of the agents/codex-bridge/ package. The file lives here out of necessity: the slash
     command name is set by its location under commands/<namespace>/, and Claude Code understands neither
     symlinks nor pointer files (verified 2026-08-02). Edit it here; it travels as a copy when the
     package is installed. -->

Which model each delegated role runs on. The three roles are the scout, the builder and the
reviewer, and each carries its own model and reasoning depth.

Run exactly this command, substituting the user's arguments (`$ARGUMENTS`), and return its output
verbatim. Add nothing and recompute nothing:

```bash
codex-bridge model $ARGUMENTS
```

Unlike the older `/codex-bridge:env`, this calls the short package command rather than a path to a
file (Plan_56 D1). The operator's standing permission rule is written for that spelling, and moving
the installed files can no longer break the call.

Call forms:

- no arguments — the model, reasoning depth and provenance of each role, plus the path of the
  config file;
- `list` — the live catalogue from Codex: every model, the reasoning levels it accepts, its default
  level and whether it offers an accelerated tier.

Two things the output says that are worth repeating to the operator if they ask:

- The profile is **machine-wide**. One config file serves every project on this machine, so
  changing a role's model changes it for all of them, not for the repository you are standing in.
- The catalogue is asked live every time. There is no cache and no bundled copy, because the copy
  inside the Codex binary lists models the server no longer has — an operator who picked one from a
  stale list would lose the quota before the run started.

Changing a value is not this command's job yet; today it only reads. While that is so, say plainly
that the file is edited by hand and name its path from the output rather than inventing a flag.
