/**
 * Classify why a finished run has no usable result from frozen stop facts, without
 * deciding recovery. Plan_80 A2/A5: recollection must give the same answer, so only
 * frozen facts are inputs; stdout receipts are not the calibrated silence signal.
 */
import { silenceAgeMs } from '../codex-session-log.mjs';

export const GRANT_POLICY_VERSION = 1;

// One reading of O1's evidence for both paths: two copies of this rule could drift apart.
const codexProvenGone = (stop) => ['stopped', 'exited'].includes(stop?.tree_stop?.state);

// Plan_80 E13/O2: grants depend on safety and identity, not the diagnosed stall kind.
export function grantBlockers({ status, resultOk, agentWrites, threadId, stop }) {
  const blockers = [];
  if (resultOk) blockers.push('result-present');
  if (status === 'LIMIT') blockers.push('limit');
  else if (status === 'UNAVAILABLE') blockers.push('unavailable');
  if (stop?.trigger === 'spawn-error' || stop?.trigger === 'stream-error') blockers.push('runner-error');
  if (agentWrites) blockers.push('writer-role-not-approved');
  if (!stop) blockers.push('stop-record-missing');
  if (!threadId) blockers.push('thread-unavailable');
  if (stop?.session?.state !== 'observed') {
    blockers.push(`session-evidence-${stop?.session?.state ?? 'not-observed'}`);
  }
  if (!codexProvenGone(stop)) blockers.push('process-tree-stop-unverified');
  return blockers;
}

export function assessStop({ status, resultOk, agentWrites, threadId, stop, silencePolicy }) {
  const cause = stop?.trigger ?? null;
  const sessionState = stop?.session?.state ?? null;
  const commandFacts = stop?.session?.at_reference?.commands;
  const commands = {
    state: commandFacts?.state ?? null,
    reason: commandFacts?.reason ?? null,
    pending_count: Array.isArray(commandFacts?.pending) ? commandFacts.pending.length : null,
  };
  const silence = silenceAgeMs(stop?.session?.at_reference, stop?.stopped_at);
  const threshold = typeof silencePolicy?.threshold_ms === 'number' ? silencePolicy.threshold_ms : null;
  let kind;
  if (resultOk) kind = 'result-present';
  else if (status === 'LIMIT') kind = 'limit';
  else if (status === 'UNAVAILABLE') kind = 'unavailable';
  else if (!stop) kind = 'evidence-unknown';
  else if (cause === 'spawn-error' || cause === 'stream-error') kind = 'runner-error';
  else if (cause === 'exit') kind = 'process-exit-no-result';
  else if (commands.state === 'in-flight') kind = 'command-in-flight';
  else if (cause === 'deadline') {
    if (commands.state !== 'none' || silence.ms === null) kind = 'evidence-unknown';
    else if (threshold === null) kind = 'silence-unclassified';
    else kind = silence.ms >= threshold ? 'silent-stall-candidate' : 'recent-activity';
  } else kind = 'evidence-unknown';

  const situation = {
    version: 1,
    kind,
    cause,
    silence_ms: silence.ms,
    silence_reason: silence.reason,
    threshold_ms: threshold,
    commands,
    session_state: sessionState,
    result_file_state: stop?.result_file?.state ?? null,
  };
  const automatic = ['recovery-not-enabled', 'resume-contract-unverified'];
  const grant = grantBlockers({ status, resultOk, agentWrites, threadId, stop });
  const factual = [];
  if (resultOk) factual.push('result-present');
  if (status === 'LIMIT') factual.push('limit');
  else if (status === 'UNAVAILABLE') factual.push('unavailable');
  if (agentWrites) factual.push('writer-role-not-approved');
  if (!threadId) factual.push('thread-unavailable');
  if (sessionState !== 'observed') factual.push(`session-evidence-${sessionState ?? 'not-observed'}`);
  if (commands.state === 'in-flight') factual.push('command-in-flight');
  else if (commands.state !== 'none') factual.push('command-evidence-unknown');
  automatic.push(...factual);
  if (threshold === null) automatic.push('threshold-unconfigured');
  // Without evidence or a calibrated threshold nobody knows whether this was a stall, so
  // "not a stall" would be a claim; those cases are already blocked by their own reasons.
  if (!['evidence-unknown', 'silence-unclassified', 'silent-stall-candidate'].includes(kind)) {
    automatic.push('not-silent-stall');
  }
  if (!codexProvenGone(stop)) automatic.push('process-tree-stop-unverified');

  const actions = {
    'result-present': 'retain-stop-facts',
    limit: 'retain-stop-facts',
    unavailable: 'retain-stop-facts',
    'silent-stall-candidate': 'retain-stop-facts',
    'recent-activity': 'retain-stop-facts',
    'process-exit-no-result': 'inspect-exit-and-drain',
    'command-in-flight': 'inspect-command-effects',
    'evidence-unknown': 'inspect-evidence',
    'silence-unclassified': 'calibrate-silence-threshold',
    'runner-error': 'inspect-runner-error',
  };
  return {
    situation,
    continuation_eligibility: {
      version: 2,
      automatic: { allowed: automatic.length === 0, blocking_reasons: automatic },
      grant: { allowed: grant.length === 0, policy_version: GRANT_POLICY_VERSION, blocking_reasons: grant },
    },
    treatment: { version: 1, effect: 'diagnostic-only', action: actions[kind] },
  };
}
