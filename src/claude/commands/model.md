---
description: Show, list or change the model and reasoning depth each delegated Codex role runs on
allowed-tools: Bash
argument-hint: "[list | set <role> <model> [effort] | unset <role> | speed <role> <tier> [confirm] | speed <role> unset]"
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

- no arguments — the model, reasoning depth, pinned speed tier and provenance of each role, plus the path of the
  config file;
- `list` — the live catalogue from Codex: every model, the reasoning levels it accepts, its default
  level and its accelerated service tier identifiers (parallel speed labels are not extra tiers);
- `set <role> <model> [effort]` — pin one role, with `--model` and `--effort` accepted instead of
  the positions. The pair is checked against that model's own catalogue entry before anything is
  written, so an unsupported depth is refused with the depths that model does accept, and a role
  whose existing depth or pinned speed tier the new model cannot keep is refused with its supported values;
- `unset <role>` — remove that role's profile, returning it to whatever Codex chooses;
- `speed <role> <tier>` — preview an accelerated tier from the pinned model's live catalogue entry.
  Pin a model with `set` first. The preview quotes the tier description verbatim and separately links
  to https://learn.chatgpt.com/docs/agent-configuration/speed for credit multipliers; it writes nothing;
- `speed <role> <tier> confirm` — fetch and validate again, then pin that exact tier and report the
  previous and new profile. Unknown tiers or an unavailable catalogue are refused without a write;
- `speed <role> unset` — remove only the speed pin immediately, preserving model and effort.
  This needs no confirmation or catalogue; with no pin the package does not interfere with speed.

Two things the output says that are worth repeating to the operator if they ask:

- The profile is **machine-wide**. One config file serves every project on this machine, so
  changing a role's model changes it for all of them, not for the repository you are standing in.
- The catalogue is asked live every time. There is no cache and no bundled copy, because the copy
  inside the Codex binary lists models the server no longer has — an operator who picked one from a
  stale list would lose the quota before the run started.

`set` and `unset` apply immediately; pinning a paid speed tier requires the second call ending in
`confirm`. Never edit the config file directly to do what these commands do — model, effort and
tier pins are checked against the live catalogue before writing.
