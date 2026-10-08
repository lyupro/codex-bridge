# order
Write a task file that gives each dispatcher the complete order and the build's file boundary.

## Call and header

The call is exactly one line: `task file: <task-file path from the orchestrator>`.
The path must be absolute and name a file the orchestrator wrote with its file tool.
The dispatcher never creates, reads or rewrites it. The whole order lives in that file's header.
The runner checks the header, never the dispatcher. Free text belongs in the task file.

Start at the first line with consecutive lowercase `label: value` lines, then a blank line and the task body.
Labels must use their exact spelling, start at column one and have a non-empty value; duplicates are refused.
The header ends at the first line that is not a recognized label line, including a blank line.
Do not put grants or advice below the header, even in a code fence; quote examples with `>` or reword them inside a sentence.

| Agent | Required labels | Conditional labels | Optional labels |
| --- | --- | --- | --- |
| codex-scout | `order id` | `continue`, `retry` | `repository`, `slug`, `effort` |
| codex-build | `order id`, `scope`, `advice` | `continue`, `retry` | `repository`, `scope new`, `slug`, `effort` |
| codex-review | `order id` | `continue`, `retry` | `repository`, `slug`, `effort`, `changeset` |
| codex-advisor | `order id`, `phase` | `continue`, `retry` | `repository`, `slug`, `effort` |

Both grant labels are conditional when this pass continues or repeats a named run. Keep exactly one grant label:
`continue` names the continued run; `retry` repeats a failed pass and does not authorize the next pass.
Each value names a bare run folder (not a path, `.` or `..`) and a non-placeholder reason, separated by ` — `, ` - ` or `:`.
For advisor, pass `scope` first, then `advise` with a `continue:` grant naming the scope run of the same order.

`repository` is the repository path; `slug` names this pass without replacing the order id.
The runner checks accepted `effort` values. `changeset` is `uncommitted`, `base:<branch>` or `commit:<sha>`.
Keep header values short and free of forbidden shell sequences. Empty or placeholder values are refused;
`phase: scope` and `effort: none` are real values.

## File boundary

`scope`: Comma-separated globs relative to the repository root, listing every file the run may touch — including each caller of what changes, not only the file being edited. Anything outside the list fails the run.

`scope new`: Comma-separated globs for new files this build may create, relative to the repository root.
`scope` must declare at least one existing path pattern; `scope new` does not replace it.
Never name service folders in scope: `.git/`, `.claude/`, `.codex/`, `.omx/`, `node_modules/`.

Example build header:

```text
order id: guidance-order-text
scope: tests/guidance-topics.test.mjs
scope new: src/home/guidance/order.md
advice: docs-only

```

## Advice

Every build task header contains exactly one `advice:` line. Its value is an absolute path to an existing run folder
whose `meta.json` identifies a `codex-advisor` advise pass with status `OK`, or exactly `mechanical`, `revert`,
`docs-only`, or `test-only`. Anything else is refused before the run starts.

## Verify

Put the verification command in the task file under a `## Verify` heading, one line.
The dispatcher never reads that file and never puts the command on the command line.

## Free refusals

A pre-start refusal creates no run folder and spends no quota; the same order id remains reusable for the corrected order.
A refusal is the dispatcher's whole answer, not a reason to change the call or task file and retry itself.
Repeating the same call for a run already in flight joins that run and costs no quota; a different piece of work needs a new label.
