# concurrency

Run readers in parallel while keeping every writing run exclusive to its working tree.

## Readers and writers

Read-only `codex-scout`, `codex-review` and both `codex-advisor` phases may run in parallel freely, including alongside a writing run.

Only one writing run may be active in a working tree. A second writing run in that tree is refused, even when the two orders name different files. Parallel writers require separate worktrees, each with its own working tree and write boundary.

The writing runner snapshots the tree before and after its run, then compares the actual changes with the reported files and order scope. Another writer's edits enter that same snapshot and appear to belong to this run. Disjoint file lists therefore do not isolate writers in one tree. Keep other file-changing operations out of a live writer's tree as well.

## Stop a live run

Use the run path from its receipt and call `codex-bridge stop <run>` before `TaskStop`. The bridge stop terminates the Codex run and records FAIL. `TaskStop` alone stops the dispatcher task while the Codex process can keep writing.

Inspect the resulting status and working-tree changes before launching another writer. Stopping a run does not undo the files it already changed.
