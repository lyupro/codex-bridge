/** Names every root outside the repository that the suite must never run against for real. */

/**
 * A fixture that does not name a root falls back to one of these variables, so the suite runner
 * replaces all of them and the isolation test asserts each one. Two incidents put entries here:
 * `~/.codex` collected a rules file on 2026-08-03, and `~/.lyupro/.codex-bridge` collected a
 * config, conventions and an obsolete-file fixture on 2026-08-11, where the stray config then
 * stood in the way of the seeded-file migration the release was about.
 *
 * `CODEX_RUNS_ROOT` joined before a failure rather than after one (Plan_65 B12): the runs root
 * falls back to the operator's `~/.claude/codex-runs`, so a runner test that did not name it
 * filed its runs among real ones, and the purge liveness checks would read real live runs as the
 * fixture's — a verdict that depends on what the operator happens to be running.
 *
 * It sits in its own module because the isolation test imports it, and importing the runner would
 * start a second suite inside the first.
 */
export const ISOLATED_ROOTS = Object.freeze(['CODEX_HOME', 'CODEX_BRIDGE_HOME', 'CODEX_RUNS_ROOT']);
