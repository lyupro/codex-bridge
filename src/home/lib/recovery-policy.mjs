/**
 * The measured recovery budget an automatic continuation of a stalled run may spend,
 * with its evidence and its package switch. Plan_80 S4/E9/E12 keep the number beside
 * its evidence so it cannot be rounded by taste, and in package-owned defaults because
 * a seeded config key never reaches installed hosts. E15 keeps automatic recovery off
 * until real stalled runs have been continued by hand; a later order enables it.
 */
import { AGENTS } from './agents.mjs';
import { resolveSilencePolicy } from './silence-policy.mjs';

export const RECOVERY_CALIBRATIONS = Object.freeze({
  'advisor.advise': Object.freeze({
    id: 'plan80-s4-2026-10-15',
    measured_on: '2026-10-15',
    window: '2026-10-01..2026-10-15',
    codex_version: '0.160.1',
    sample_runs: 322,
    measure: 'last exec or read tool output to the final answer, Codex session log, successful runs',
    max_tail_ms: 917634,
    margin: 0.2,
    rule: 'ceil(max_tail_ms * (1 + margin) / 1000) * 1000',
  }),
});

export function deriveRecoveryBudgetMs(calibration) {
  return Math.ceil(calibration.max_tail_ms * (1 + calibration.margin) / 1000) * 1000;
}

export const AUTOMATIC_RECOVERY_ENABLED = Object.freeze({ 'advisor.advise': false });

export function resolveRecoveryPolicy(agent, phase, registry = AGENTS, {
  calibrations = RECOVERY_CALIBRATIONS,
  automaticRecoveryEnabled = AUTOMATIC_RECOVERY_ENABLED,
} = {}) {
  if (!Object.hasOwn(registry, agent)) throw new Error(`Unknown agent: ${agent}`);
  const entry = registry[agent];
  const phased = typeof entry.budget === 'object' && entry.budget !== null;
  if (phased ? !Object.hasOwn(entry.budget, phase) : phase !== 'default') {
    throw new Error(`Unknown phase for ${agent}: ${phase}`);
  }
  const budget = phased ? entry.recoveryBudgetMs?.[phase] : entry.recoveryBudgetMs;
  if (budget !== null && (!Number.isInteger(budget) || budget <= 0)) {
    throw new Error(`Invalid recovery budget for ${agent}.${phase}: expected null or a positive integer`);
  }
  const role = entry.role;
  const key = `${role}.${phase}`;
  const calibration = Object.hasOwn(calibrations, key) ? calibrations[key] : null;
  if (budget !== null && calibration === null) {
    throw new Error(`Missing recovery calibration for ${key}`);
  }
  if (budget === null && calibration !== null) {
    throw new Error(`Recovery calibration for ${key} requires a budget`);
  }
  if (calibration !== null) {
    const derived = deriveRecoveryBudgetMs(calibration);
    if (budget !== derived) {
      throw new Error(`Recovery budget for ${key}: registry ${budget} differs from calibration ${derived}; the number and its evidence change together`);
    }
  }
  const enabled = Object.hasOwn(automaticRecoveryEnabled, key) ? automaticRecoveryEnabled[key] : false;
  // A truthy non-boolean would be recorded as the run's switch while every check here skipped it.
  if (typeof enabled !== 'boolean') {
    throw new Error(`Automatic recovery switch for ${key}: expected true or false`);
  }
  if (enabled === true) {
    if (budget === null) throw new Error(`Automatic recovery for ${key} requires a recovery budget`);
    if (resolveSilencePolicy(agent, phase, registry).threshold_ms === null) {
      throw new Error(`Automatic recovery for ${key} requires a silence threshold`);
    }
  }
  return { version: 1, role, phase, budget_ms: budget, enabled, calibration };
}
