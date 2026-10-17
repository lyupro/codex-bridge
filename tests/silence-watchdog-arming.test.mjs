/** Plan_80 E16 keeps the live silence detector in shadow independently of recovery. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SILENCE_WATCHDOG_ARMED, resolveWatchdogArming } from '../src/home/lib/silence-watchdog-arming.mjs';

const silencePolicy = { role: 'advisor', phase: 'advise', threshold_ms: 996000 };
const brake = { value: 'on' };
const resolve = (overrides = {}) => resolveWatchdogArming({ silencePolicy, brake, ...overrides });

test('the shipped advisor advise switch is frozen and false', () => {
  assert.equal(SILENCE_WATCHDOG_ARMED['advisor.advise'], false);
  assert.equal(Object.isFrozen(SILENCE_WATCHDOG_ARMED), true);
});

test('no threshold takes precedence over the brake and retains the package switch', () => {
  for (const value of ['on', 'off']) {
    assert.deepEqual(resolve({ silencePolicy: { ...silencePolicy, threshold_ms: null },
      brake: { value }, armed: { 'advisor.advise': true } }), {
      version: 1, arming: 'off', reason: 'no-threshold', armed_switch: true,
    });
  }
});

test('the host brake disables even an armed package switch', () => {
  assert.deepEqual(resolve({ brake: { value: 'off' }, armed: { 'advisor.advise': true } }), {
    version: 1, arming: 'off', reason: 'host-brake', armed_switch: true,
  });
});

test('a false package switch selects shadow; a true switch selects armed', () => {
  assert.deepEqual(resolve(), {
    version: 1, arming: 'shadow', reason: 'package-switch-off', armed_switch: false,
  });
  assert.deepEqual(resolve({ armed: { 'advisor.advise': true } }), {
    version: 1, arming: 'armed', reason: 'package-switch', armed_switch: true,
  });
});

test('an absent or inherited package key is false', () => {
  for (const armed of [{}, Object.create({ 'advisor.advise': true })]) {
    assert.deepEqual(resolve({ armed }), {
      version: 1, arming: 'shadow', reason: 'package-switch-off', armed_switch: false,
    });
  }
});

test('non-boolean switches throw even when a threshold or host brake disables detection', () => {
  for (const value of [undefined, null, 0, 1, 'false', 'true']) {
    for (const overrides of [{}, { brake: { value: 'off' } },
      { silencePolicy: { ...silencePolicy, threshold_ms: null } }]) {
      assert.throws(() => resolve({ ...overrides, armed: { 'advisor.advise': value } }),
        /^Error: Silence watchdog switch for advisor\.advise: expected true or false$/);
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
  for (const armed of [null, [], true]) {
    assert.throws(() => resolve({ armed }), /switches/);
  }
});

test('arming resolution has no environment or automatic recovery switch dependency', () => {
  const source = fs.readFileSync(new URL('../src/home/lib/silence-watchdog-arming.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /AUTOMATIC_RECOVERY_ENABLED|process\.env/);
});
