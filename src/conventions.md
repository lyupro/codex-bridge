# Delegated-run conventions

These are the host conventions for every Codex run. Each block records a real acceptance
violation caught in this repository and turns it into a guard for the next run.

## Task boundaries - Plan_16 acceptance incident

- Do not refactor code the task did not ask to change.
- Do not delete code on your own initiative.
- Do not change behavior branches whose behavior the task does not mention, even inside an
  allowed file.

The 2026-08-06 Plan_16 acceptance finding applied a new reason order to a transport branch that
already named its reason. Preserve existing branches unless the task explicitly changes them.

## Contracts without silent defaults - Plan_16 reasonFrom incident

- Require arguments that the contract needs instead of supplying a default.
- Fail loud when a required value is absent; do not silently fall back.
- Keep volatile identifiers such as model IDs and API versions in configuration, not runtime code.

The 2026-08-06 `reasonFrom(runDir, eventData = {})` finding replaced a required contract with a
silent default. Missing inputs must remain visible at the boundary that can explain them.

## Structure and size - 2026-08-06 projects reload incident

- Keep every source file at or below 400 lines.
- Give each module one responsibility.
- Do not create `utils.mjs` dumping grounds.
- Never split coherent pieces solely to reach the line limit.

The 2026-08-06 `projects` reload finding exposed pseudo-duplicate exports and just-in-case code.
Keep related code together, but remove a real responsibility or create a focused module when a
boundary is needed.

## Tests and comments - 2026-08-05 step 2b incident

- Add a guard test for every invariant accepted by the task.
- Splitting a file must delete no test case.
- Comments explain WHY and name the incident or decision that makes the rule necessary.

The 2026-08-05 step 2b acceptance found the abandoned-run check below the commit check. Test the
ordering invariant itself, and leave the incident in the comment so a later cleanup does not
silently undo it.
