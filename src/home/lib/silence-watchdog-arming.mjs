/**
 * Resolves the run's frozen diagnostic silence watchdog policy.
 * Plan_80 E25 retires stopping: two healthy passes stayed quiet about 17 minutes,
 * and encrypted Codex reasoning makes healthy thinking indistinguishable from stalls.
 */
export function resolveWatchdogArming({ silencePolicy, brake } = {}) {
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
  const [arming, reason] = threshold === null ? ['off', 'no-threshold'] :
    brake.value === 'off' ? ['off', 'host-brake'] :
      ['shadow', 'stopping-retired'];
  return { version: 1, arming, reason, armed_switch: false };
}
