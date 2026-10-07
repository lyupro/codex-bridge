/** decides which handback-witness observations one subagent stop produces
 * Plan_67 D8 requires recovery evidence for each cause; D9 requires dispatcher evidence for untyped stops.
 */
import { recordWitnessObservations } from '../lib/handback-witness.mjs';

export function untypedStopObservation({ evidence, hostVersion, agentId }) {
  const alarm = evidence.dispatcher === true;
  return {
    observation: {
      cause: 'missing-agent-type', hostVersion, agentType: null,
      verdict: alarm ? 'violation' : 'undetermined',
      detail: alarm ? `host omitted agent_type for agent ${agentId}; evidence: ${evidence.via}`
        : `untyped subagent stop without dispatcher evidence (${evidence.reason})`,
    },
    alarm,
  };
}

export function typedStopObservations({ agentType, hostVersion, agentId, hasIds, state, toolUses, unseen }) {
  const observations = hasIds ? [
    { cause: 'missing-agent-type', hostVersion, agentType: null, verdict: 'match' },
    { cause: 'missing-ids', hostVersion, agentType, verdict: 'match' },
  ] : [{
    cause: 'missing-ids', hostVersion, agentType, verdict: 'violation',
    detail: `host omitted session_id or agent_id for ${agentType}`,
  }];
  if (unseen.length) {
    observations.push({
      cause: 'tools-outside-gate', hostVersion, agentType, verdict: 'violation',
      detail: `${agentType} ${agentId}: ${unseen.map(({ name }) => name).join(', ')} outside the dispatcher gate`,
    });
  } else if (toolUses !== null && state && !state.corrupt && state.auditAlarmed !== true
    && state.handback === 'delivered' && state.runnerFinal === true && !state.runReceiptConflict) {
    // D8: denied attempts and synthetic gate FAILs (dispatcher-gate.mjs:70-92) cannot clear an audit alarm.
    observations.push({ cause: 'tools-outside-gate', hostVersion, agentType, verdict: 'match' });
  }
  return observations;
}

export async function recordStopWitness({ stateDir, observations }) {
  try {
    await recordWitnessObservations({ stateDir, observations });
  } catch {
    // Plan_66 H2: witness failures never block work.
  }
}
