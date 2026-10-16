# order
Write a task file that gives each dispatcher the complete order and the build's file boundary.

## Call and header

The call is exactly one line: `task file: <task-file path from the orchestrator>`.
The dispatcher never creates, reads or rewrites it. The whole order lives in that file's header.
The runner checks the header, never the dispatcher. Free text belongs in the task file.

Start at the first line with consecutive lowercase `label: value` lines, then a blank line and the task body.
The header ends at the first line that is not a recognized label line, including a blank line.

| Agent | Required labels | Conditional labels | Optional labels |
| --- | --- | --- | --- |
| codex-scout | `order id` | `continue`, `retry`, `resume` | `repository`, `slug`, `effort` |
| codex-build | `order id`, `scope`, `advice` | `continue`, `retry` | `repository`, `scope new`, `slug`, `effort` |
| codex-review | `order id` | `continue`, `retry`, `resume` | `repository`, `slug`, `effort`, `changeset` |
| codex-advisor | `order id`, `phase` | `continue`, `retry`, `resume` | `repository`, `slug`, `effort` |

The three grant labels are conditional when this pass continues or repeats a named run: `continue` names the continued run; `retry` repeats a failed pass on a fresh thread; `resume` continues a failed read-only pass in its own Codex thread; neither `retry` nor `resume` authorizes the next pass.
Under `resume:`, the task body is a plain note for the record, saved as written (surrounding blank lines trimmed) as `resume-note.md` in the new run folder and never read by the resumed run, which reuses the frozen questions, options, paths and verification of the named run.
Questions, Options, Paths and Verify headings in that body are refused before start; a changed task needs `retry:` or a new order id.
For advisor, pass `scope` first, then `advise` with a `continue:` grant naming the scope run of the same order.

`repository` is the repository path; `slug` names this pass without replacing the order id.
The runner checks accepted `effort` values. `changeset` is `uncommitted`, `base:<branch>` or `commit:<sha>`.
Forbidden shell sequences are {{shell-unsafe-sequences}}.
`phase: scope` and `effort: none` are real values, not placeholders.

## File boundary

`scope`: Comma-separated globs relative to the repository root, listing every file the run may touch — including each caller of what changes, not only the file being edited. Anything outside the list fails the run.

`scope new`: Comma-separated globs for new files this build may create, relative to the repository root.
Paths listed in `scope new` are already inside the run's boundary, so they are not repeated in `scope`.
<!-- service-folders:begin -->
Never name service folders in scope: `.git/`, `.claude/`, `.codex/`, `.omx/`, `.omc/`, `node_modules/`.
<!-- service-folders:end -->

Example build header:

```text
order id: guidance-order-text
scope: tests/guidance-topics.test.mjs
scope new: src/home/guidance/order.md
advice: docs-only

```

## Advice

Every build task header contains exactly one `advice:` line.

## Verify

Put the verification command in the task file under a `## Verify` heading.
The dispatcher never reads that file and never puts the command on the command line.

## Rules the runner enforces

These are the rules a pre-start refusal names.

{{order-rules:all}}

## Free refusals

A pre-start refusal creates no run folder and spends no quota; the same order id remains reusable for the corrected order.
A refusal is the dispatcher's whole answer, not a reason to change the call or task file and retry itself.
Repeating the same call for a run already in flight joins that run and costs no quota; a different piece of work needs a new label.
