/** Plan_80 E25 permanently retires silence-based stopping for every role and phase. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveWatchdogArming } from '../src/home/lib/silence-watchdog-arming.mjs';
import { AGENTS } from '../src/home/lib/agents.mjs';

const silencePolicy = { role: 'advisor', phase: 'advise', threshold_ms: 996000 };
const brake = { value: 'on' };
const resolve = (overrides = {}) => resolveWatchdogArming({ silencePolicy, brake, ...overrides });

test('no threshold takes precedence over the brake with armed_switch false', () => {
  for (const value of ['on', 'off']) {
    assert.deepEqual(resolve({ silencePolicy: { ...silencePolicy, threshold_ms: null },
      brake: { value } }), {
      version: 1, arming: 'off', reason: 'no-threshold', armed_switch: false,
    });
  }
});

test('the host brake disables the watchdog with armed_switch false', () => {
  assert.deepEqual(resolve({ brake: { value: 'off' } }), {
    version: 1, arming: 'off', reason: 'host-brake', armed_switch: false,
  });
});

test('a positive threshold and on brake select shadow because stopping is retired', () => {
  assert.deepEqual(resolve(), {
    version: 1, arming: 'shadow', reason: 'stopping-retired', armed_switch: false,
  });
});

test('Plan_80 E25: every registry role and phase can only select shadow with a positive threshold', () => {
  for (const { role, budget } of Object.values(AGENTS)) {
    const phases = typeof budget === 'number' ? ['default'] : Object.keys(budget);
    for (const phase of phases) {
      const result = resolve({ silencePolicy: { role, phase, threshold_ms: 1 } });
      assert.notEqual(result.arming, 'armed', `${role}.${phase}`);
      assert.deepEqual(result, {
        version: 1, arming: 'shadow', reason: 'stopping-retired', armed_switch: false,
      });
    }
  }
});

test('an extra armed option has no effect on any policy result', () => {
  for (const armed of [{ 'advisor.advise': true }, {}, null, [], true, 'true']) {
    for (const overrides of [{}, { brake: { value: 'off' } },
      { silencePolicy: { ...silencePolicy, threshold_ms: null } }]) {
      assert.deepEqual(resolve({ ...overrides, armed }), resolve(overrides));
    }
  }
});

test('missing or malformed policy and brake name the invalid input', () => {
  assert.throws(() => resolveWatchdogArming(), /silencePolicy/);
  for (const value of [undefined, null, [], 'policy']) {
    assert.throws(() => resolve({ silencePolicy: value }), /silencePolicy/);
  }
  for (const field of ['role', 'phase']) {
    for (const value of [undefined, null, '', ' ', 3]) {
      assert.throws(() => resolve({ silencePolicy: { ...silencePolicy, [field]: value } }),
        new RegExp(`silencePolicy\\.${field}`));
    }
  }
  for (const threshold_ms of [undefined, -1, 0, 1.5, '996000', NaN, Infinity]) {
    assert.throws(() => resolve({ silencePolicy: { ...silencePolicy, threshold_ms } }),
      /silencePolicy\.threshold_ms/);
  }
  for (const value of [undefined, null, [], 'off']) {
    assert.throws(() => resolve({ brake: value }), /brake/);
  }
  for (const value of [undefined, null, '', 'ON', false]) {
    assert.throws(() => resolve({ brake: { value } }), /brake\.value/);
  }
});

test('arming resolution has no environment or automatic recovery switch dependency', () => {
  const source = fs.readFileSync(new URL('../src/home/lib/silence-watchdog-arming.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /AUTOMATIC_RECOVERY_ENABLED|process\.env/);
});
