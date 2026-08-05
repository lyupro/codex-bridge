/**
 * Names the hooks this package registers in a host, and the tools they listen to.
 *
 * The gate and the installer would otherwise each carry their own idea of which tool starts a
 * subagent, and the first host that renames it would leave a registered hook listening for a
 * tool that never fires — silence indistinguishable from approval, which is the exact failure
 * the gate exists to end. `cli/manifest.mjs` builds the settings matcher from SUBAGENT_TOOLS
 * and `src/hooks/order-gate.mjs` recognises the same names, so a matcher can never drift away
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

export const HOOK_DEFINITIONS = Object.freeze([
  Object.freeze({ event: 'SubagentStop', matcher: '*', file: 'reply-guard.mjs' }),
  Object.freeze({ event: 'PreToolUse', matcher: SUBAGENT_TOOL_MATCHER, file: 'order-gate.mjs' }),
  Object.freeze({ event: 'PreToolUse', matcher: WRITE_TOOL_MATCHER, file: 'worktree-lock.mjs' }),
]);
