/**
 * The calibrated silence policy that a run is judged by, with its evidence.
 * Plan_80 S2 and E12 keep the measurement beside the package-owned registry default:
 * a number without its evidence gets changed to a rounder one, and a seeded config key
 * never reaches installed hosts. Each run records this policy before the worker starts;
 * this release only records it and makes no silence-based decisions.
 */
import { AGENTS } from './agents.mjs';

export const CALIBRATIONS = Object.freeze({
  'advisor.advise': Object.freeze({
    id: 'plan80-s2-2026-10-13',
    measured_on: '2026-10-13',
    codex_version: '0.160.1',
    sample_runs: 308,
    max_healthy_pause_ms: 855163,
    min_stalled_silence_ms: 1136878,
    rule: 'midpoint of the healthy maximum and the stalled minimum',
  }),
});

export function resolveSilencePolicy(agent, phase, registry = AGENTS) {
  if (!Object.hasOwn(registry, agent)) throw new Error(`Unknown agent: ${agent}`);
  const entry = registry[agent];
  const phased = typeof entry.budget === 'object' && entry.budget !== null;
  if (phased ? !Object.hasOwn(entry.budget, phase) : phase !== 'default') {
    throw new Error(`Unknown phase for ${agent}: ${phase}`);
  }
  const threshold = phased ? entry.silenceThresholdMs?.[phase] : entry.silenceThresholdMs;
  if (threshold !== null && (!Number.isInteger(threshold) || threshold <= 0)) {
    throw new Error(`Invalid silence threshold for ${agent}.${phase}: expected null or a positive integer`);
  }
  const role = entry.role;
  const key = `${role}.${phase}`;
  const calibration = Object.hasOwn(CALIBRATIONS, key) ? CALIBRATIONS[key] : null;
  if (threshold !== null && calibration === null) {
    throw new Error(`Missing silence calibration for ${key}`);
  }
  if (threshold === null && calibration !== null) {
    throw new Error(`Silence calibration for ${key} requires a threshold`);
  }
  return { version: 1, role, phase, threshold_ms: threshold, calibration };
}
