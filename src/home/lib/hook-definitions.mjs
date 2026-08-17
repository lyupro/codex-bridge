/**
 * Names the hooks this package registers in a host, and the tools they listen to.
 *
 * The gate and the installer would otherwise each carry their own idea of which tool starts a
 * subagent, and the first host that renames it would leave a registered hook listening for a
 * tool that never fires — silence indistinguishable from approval, which is the exact failure
 * the gate exists to end. `cli/manifest.mjs` builds the settings matcher from SUBAGENT_TOOLS
 * and `src/home/hooks/order-gate.mjs` recognises the same names, so a matcher can never drift away
 * from what the hook actually checks.
 */

/**
 * Every name a Claude Code host has used for the tool that launches a subagent. Both are live:
 * this package is installed into hosts of different ages, `Task` is the long-standing name and
 * `Agent` the current one. A hook registered for only one of them is dead weight on the other.
 */
export const SUBAGENT_TOOLS = Object.freeze(['Agent', 'Task']);

/** A PreToolUse matcher is a regular expression over tool names, so alternation covers both. */
export const SUBAGENT_TOOL_MATCHER = SUBAGENT_TOOLS.join('|');

/**
 * File-writing tools differ across Claude Code hosts just like subagent tools do. Register every
 * host spelling here so the worktree lock receives the edit before it can enter a live runner's
 * before/after snapshot; a list kept only in the hook would leave one host silently unlocked.
 */
export const WRITE_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** A PreToolUse matcher is a regular expression over tool names, so alternation covers all four. */
export const WRITE_TOOL_MATCHER = WRITE_TOOLS.join('|');

/**
 * Shell tools, listed here for the same reason as the two lists above: the prune guard must see the
 * command whichever name a host gives its shell, and a name known only to the hook would leave that
 * host's agents able to delete run artifacts.
 */
export const SHELL_TOOLS = Object.freeze(['Bash', 'PowerShell']);

/** A PreToolUse matcher is a regular expression over tool names, so alternation covers both. */
export const SHELL_TOOL_MATCHER = SHELL_TOOLS.join('|');

// Plan_31 routes host stop requests through the package guard; keep the matcher derived from
// the tool list so registration and uninstall cannot drift from the host event spelling.
export const STOP_TOOLS = Object.freeze(['TaskStop']);

/** A PreToolUse matcher is a regular expression over tool names, so the list remains authoritative. */
export const STOP_TOOL_MATCHER = STOP_TOOLS.join('|');

/**
 * Stable CLI names live beside each event and file because the Plan_19 drift incident left
 * registration, diagnostics, and the guard itself carrying different hook identities. The
 * dispatcher must consume this one list instead of guessing a name from a path at its call site.
 */
export const HOOK_DEFINITIONS = Object.freeze([
  Object.freeze({ name: 'reply-guard', event: 'SubagentStop', matcher: '*', file: 'reply-guard.mjs' }),
  Object.freeze({ name: 'order-gate', event: 'PreToolUse', matcher: SUBAGENT_TOOL_MATCHER, file: 'order-gate.mjs' }),
  Object.freeze({ name: 'worktree-lock', event: 'PreToolUse', matcher: WRITE_TOOL_MATCHER, file: 'worktree-lock.mjs' }),
  Object.freeze({ name: 'prune-guard', event: 'PreToolUse', matcher: SHELL_TOOL_MATCHER, file: 'prune-guard.mjs' }),
  Object.freeze({ name: 'worktree-witness', event: 'PostToolUse', matcher: SHELL_TOOL_MATCHER, file: 'worktree-witness.mjs' }),
  Object.freeze({ name: 'stop-guard', event: 'PreToolUse', matcher: STOP_TOOL_MATCHER, file: 'stop-guard.mjs' }),
]);
