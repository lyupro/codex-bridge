---
description: Show, list or change the model and reasoning depth each delegated Codex role runs on
allowed-tools: Bash
argument-hint: "[list | set <role> <model> [effort] | unset <role>]"
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
  level and whether it offers an accelerated tier;
- `set <role> <model> [effort]` — pin one role, with `--model` and `--effort` accepted instead of
  the positions. The pair is checked against that model's own catalogue entry before anything is
  written, so an unsupported depth is refused with the depths that model does accept, and a role
  whose existing depth the new model cannot do is refused rather than quietly moved;
- `unset <role>` — remove that role's profile, returning it to whatever Codex chooses.

Two things the output says that are worth repeating to the operator if they ask:

- The profile is **machine-wide**. One config file serves every project on this machine, so
  changing a role's model changes it for all of them, not for the repository you are standing in.
- The catalogue is asked live every time. There is no cache and no bundled copy, because the copy
  inside the Codex binary lists models the server no longer has — an operator who picked one from a
  stale list would lose the quota before the run started.

A write takes effect immediately and there is no confirming second call: changing a model back is
one command. Never edit the config file directly to do what `set` and `unset` do — the command is
what checks the pair against the catalogue, and a hand-written pair can die on quota already spent.
