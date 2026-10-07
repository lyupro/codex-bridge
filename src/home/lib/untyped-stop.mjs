/** decides whether a subagent stop without agent_type was a Codex dispatcher, from evidence bound to that stop
 * Plan_67 D9: all 13 missing-type alarms across nine host versions were noise; require evidence
 * for this stop instead of assuming every untyped subagent is a dispatcher.
 */
import { CLI_NAMES } from './cli-names.mjs';
import { ORDER_AGENTS } from './order-schema.mjs';

export function untypedStopEvidence({ state, toolUses }) {
  if (state && typeof state === 'object' && !Array.isArray(state) && !state.corrupt
    && typeof state.agentType === 'string' && ORDER_AGENTS.includes(state.agentType)
    && Array.isArray(state.seenToolUseIds) && state.seenToolUseIds.length > 0) {
    return { dispatcher: true, via: 'gate-state', agentType: state.agentType };
  }

  if (toolUses !== null) {
    for (const toolUse of toolUses) {
      if (toolUse?.name !== 'Bash' || typeof toolUse.command !== 'string'
        || /[;&|`$<>\r\n]/.test(toolUse.command)) continue;
      const tokens = toolUse.command.trim().split(/\s+/);
      if (!CLI_NAMES.includes(tokens[0]) || tokens[1] !== 'run') continue;
      for (let index = 2; index < tokens.length - 1; index += 1) {
        if (tokens[index] === '--agent' && ORDER_AGENTS.includes(tokens[index + 1])) {
          return { dispatcher: true, via: 'run-command', runAgent: tokens[index + 1] };
        }
      }
    }
  }

  return { dispatcher: false, reason: toolUses === null ? 'transcript-unreadable' : 'no-evidence' };
}
