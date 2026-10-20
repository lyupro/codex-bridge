/**
 * Decides from the Codex session log whether a running Codex is stalled and
 * records what the watchdog saw. Plan_80 S1/S2 stalls go silent for 19-23 minutes
 * after minute 2-6; E12 calibrates the threshold, and E25 retires silence-based
 * stopping while preserving shadow diagnostics.
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
  if (!['off', 'shadow'].includes(arming)) {
    throw new Error('Invalid silence watchdog arming: expected off or shadow; Plan_80 E25: silence-based stopping is retired');
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

  /** Plan_80 E28: only records diagnostics and returns nothing. */
  function check() {
    if (arming === 'off' || decision !== null || fault !== null) return;
    try {
      if (threadId === null) {
        threadId = readEvents(runDir).session_id;
        if (threadId === null) return;
        startedAt = readJsonFileSync(path.join(runDir, 'status.json')).started_at;
      }
      const first = observe();
      if (!first.verdict.stall) return;
      const second = observe();
      if (!second.verdict.stall) return;
      decision = {
        at: first.referenceAt, silence_ms: first.verdict.silence_ms,
        confirmed_at: second.referenceAt, action: 'recorded',
      };
      return;
    } catch (error) {
      // Plan_80 B1b1: a diagnostic reader TypeError must never fail a good run.
      fault = error?.message ?? String(error);
      return;
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
