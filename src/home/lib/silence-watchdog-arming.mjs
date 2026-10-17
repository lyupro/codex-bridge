/**
 * Resolves how a run's silence watchdog is armed — off, shadow or armed — frozen per run.
 * Plan_80 E16: the live detector is unproven and the margin over the longest
 * healthy pause is only 141 s, so it starts in shadow. This package switch is
 * separate from automatic recovery.
 */
export const SILENCE_WATCHDOG_ARMED = Object.freeze({ 'advisor.advise': false });

export function resolveWatchdogArming({ silencePolicy, brake, armed = SILENCE_WATCHDOG_ARMED } = {}) {
  if (!silencePolicy || typeof silencePolicy !== 'object' || Array.isArray(silencePolicy)) {
    throw new Error('Missing or malformed silencePolicy: expected an object');
  }
  for (const field of ['role', 'phase']) {
    if (typeof silencePolicy[field] !== 'string' || !silencePolicy[field].trim()) {
      throw new Error(`Missing or malformed silencePolicy.${field}: expected a non-empty string`);
    }
  }
  const threshold = silencePolicy.threshold_ms;
  if (threshold !== null && (!Number.isInteger(threshold) || threshold <= 0)) {
    throw new Error('Missing or malformed silencePolicy.threshold_ms: expected null or a positive integer');
  }
  if (!brake || typeof brake !== 'object' || Array.isArray(brake)) {
    throw new Error('Missing or malformed brake: expected an object');
  }
  if (brake.value !== 'on' && brake.value !== 'off') {
    throw new Error('Missing or malformed brake.value: expected on or off');
  }
  if (!armed || typeof armed !== 'object' || Array.isArray(armed)) {
    throw new Error('Malformed silence watchdog switches: expected an object');
  }
  const key = `${silencePolicy.role}.${silencePolicy.phase}`;
  const armedSwitch = Object.hasOwn(armed, key) ? armed[key] : false;
  if (typeof armedSwitch !== 'boolean') {
    throw new Error(`Silence watchdog switch for ${key}: expected true or false`);
  }
  const [arming, reason] = threshold === null ? ['off', 'no-threshold'] :
    brake.value === 'off' ? ['off', 'host-brake'] :
      armedSwitch ? ['armed', 'package-switch'] : ['shadow', 'package-switch-off'];
  return { version: 1, arming, reason, armed_switch: armedSwitch };
}
