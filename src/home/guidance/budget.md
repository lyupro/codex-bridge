# budget

Slice each order before launch so its work and verification fit the agent's hard wall-clock deadline.

## Budgets

The agent registry defines these budgets:

| Agent | Phase | Minutes |
| --- | --- | --- |
| codex-scout | — | 15 |
| codex-build | — | 25 |
| codex-review | — | 20 |
| codex-advisor | scope | 10 |
| codex-advisor | advise | 25 |

Advisor phases have separate deadlines; scope and advise are not one combined writing budget. The deadline is enforced by the runner, not an estimate to extend while work is in progress.

## Slice a writing run

Keep a build order to one layer and a few writing files, normally 1–3 plus their targeted tests. Split cross-layer changes into separately verifiable orders before launch. Account for reading, implementation and verification within the same 25 minutes.

The task file must say:

- The concrete result and exact write scope, including any new files.
- The budget, the small set of sources to read, and an instruction to implement immediately without exploring beyond those sources.
- The behavior to preserve and what remains outside this slice.
- The targeted check under `## Verify`, as one command line.
- No full suite, build or smoke inside the run; leave broad integration checks outside this slice.

Do not turn a small implementation order into a repository audit. Narrow the order rather than hoping the deadline will spare unfinished work.

## After a deadline FAIL

Inspect `git status` and the working-tree diff first: deadline termination can leave useful or incomplete changes. Then inspect the available result, report and events, using `codex-bridge read <run>` to render the event stream. Check which requested work and verification actually completed before deciding the next order.

Never resend the same order unchanged. Preserve the existing work and define a smaller remaining slice with an appropriate `continue:` or `retry:` grant and its reason. A deadline FAIL is not evidence that nothing was written or that the work is complete.
