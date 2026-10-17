/**
 * Decides from the Codex session log whether a running Codex is stalled and
 * records what the watchdog saw. Plan_80 S1/S2 stalls go silent for 19-23 minutes
 * after minute 2-6; E12 calibrates the threshold, and E16 requires shadow before
 * arming the live detector.
 */
import path from 'node:path';
import { readSessionActivity, silenceAgeMs } from '../codex-session-log.mjs';
import { readEvents } from '../meta/events.mjs';
import { readJsonFileSync } from '../json-file.mjs';

export function stallVerdict({ activity, referenceAt, thresholdMs }) {
  const silence = silenceAgeMs(activity?.at_reference, referenceAt).ms;
  const verdict = (stall, reason) => ({ stall, silence_ms: silence, reason });
  if (activity?.state !== 'observed') return verdict(false, activity?.state ?? 'not-observed');
  const commands = activity.at_reference?.commands?.state;
  if (commands !== 'none') return verdict(false, `commands-${commands ?? 'unknown'}`);
  if (silence === null) return verdict(false, 'no-silence');
  return silence >= thresholdMs ? verdict(true, 'threshold-reached') : verdict(false, 'below-threshold');
}

export function createSilenceWatchdog({
  runDir, arming, thresholdMs, intervalMs = 30000, now = () => new Date(), read = readSessionActivity,
}) {
  if (!['off', 'shadow', 'armed'].includes(arming)) {
    throw new Error('Invalid silence watchdog arming: expected off, shadow or armed');
  }
  if (arming !== 'off' && (!Number.isInteger(thresholdMs) || thresholdMs <= 0)) {
    throw new Error('Silence watchdog thresholdMs: expected a positive integer');
  }
  const interval = arming === 'off' ? null : intervalMs;
  let threadId = null;
  let startedAt;
  let checks = 0;
  let lastObservation = null;
  let decision = null;
  let fault = null;

  function observe() {
    const referenceAt = now().toISOString();
    const activity = read({ threadId, startedAt, referenceAt });
    checks += 1;
    const verdict = stallVerdict({ activity, referenceAt, thresholdMs });
    lastObservation = {
      at: referenceAt, state: activity.state,
      commands: activity.at_reference?.commands?.state ?? null, silence_ms: verdict.silence_ms,
    };
    return { referenceAt, verdict };
  }

  // check() is synchronous, so the caller's timer cannot re-enter it.
  function check() {
    if (arming === 'off' || decision !== null || fault !== null) return 'none';
    try {
      if (threadId === null) {
        threadId = readEvents(runDir).session_id;
        if (threadId === null) return 'none';
        startedAt = readJsonFileSync(path.join(runDir, 'status.json')).started_at;
      }
      const first = observe();
      if (!first.verdict.stall) return 'none';
      const second = observe();
      if (!second.verdict.stall) return 'none';
      decision = {
        at: first.referenceAt, silence_ms: first.verdict.silence_ms,
        confirmed_at: second.referenceAt, action: arming === 'shadow' ? 'recorded' : 'stop',
      };
      return arming === 'armed' ? 'stop' : 'none';
    } catch (error) {
      // Plan_80 B1b1: a diagnostic reader TypeError must never fail a good run.
      fault = error?.message ?? String(error);
      return 'none';
    }
  }

  function record() {
    return {
      version: 1, arming, threshold_ms: thresholdMs, interval_ms: interval,
      checks, last_observation: lastObservation, decision, fault,
    };
  }

  return { arming, intervalMs: interval, check, record };
}
