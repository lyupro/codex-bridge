/** Guards Plan_80 E16 (4)/E19: unknown shadow evidence must not authorize arming. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { silenceWatchdogShadowCheck } from '../../cli/doctor-silence-watchdog-shadow.mjs';
import { check } from '../../cli/doctor-format.mjs';
import { withTempTree } from '../temp-tree.mjs';

const empty = 'no shadow watchdog record in the last 30 days';
const tail = '; outside the shadow cohort: off 0, armed 0, not recorded 0, unknown version 0';
const review = '; review every false-stop run before arming, inspect watchdog faults and unknown record versions; doctor does not track which false stops were reviewed';
const decision = { action: 'recorded', at: '2026-10-14T10:00:00Z', confirmed_at: '2026-10-14T10:00:02Z', silence_ms: 1000 };

function meta(watchdog = {}, overrides = {}) {
  return {
    status: 'FAIL', silence_policy: { role: 'advisor', phase: 'advise' },
    stop: {
      version: 2, trigger: 'deadline',
      watchdog: {
        version: 1, arming: 'shadow', threshold_ms: 1000, interval_ms: 100,
        checks: 2, last_observation: null, decision: null, fault: null, ...watchdog,
      },
    },
    ...overrides,
  };
}

function record(value, run = 'run', project = 'project') {
  return { project, run, runDir: `/unused/${project}/${run}`, status: null, meta: value };
}

function row(records = [], extra = {}) {
  return silenceWatchdogShadowCheck({ records: { records, days: 30, unreadable: 0, ...extra } });
}

function group({ count = 1, ok = 0, deadline = 0, other = 0, observed = 0, unseen = 0, faults = 0,
  key = 'advisor.advise', thresholds = '1000' } = {}) {
  return `${key} (threshold ${thresholds} ms): ${count} shadow runs — would stop on OK ${ok}, on deadline ${deadline}, other outcome ${other}; observed without a decision ${observed}; not observed ${unseen}; faults ${faults}`;
}

const cases = [
  ['not-recorded', { status: 'OK' }, empty + tail.replace('not recorded 0', 'not recorded 1'), 'ok'],
  ['unknown-version', meta({ version: 2 }), empty + tail.replace('unknown version 0', 'unknown version 1') + review, 'warn'],
  ['off', meta({ arming: 'off' }), empty + tail.replace('off 0', 'off 1'), 'ok'],
  ['armed', meta({ arming: 'armed' }), empty + tail.replace('armed 0', 'armed 1'), 'ok'],
  ['fault', meta({ fault: 'read error' }), group({ faults: 1 }) + tail + review, 'warn'],
  ['false-stop', meta({ decision }, { status: 'OK' }), group({ ok: 1 }) + ' [project/run]' + tail + review, 'warn'],
  ['true-stop', meta({ decision }), group({ deadline: 1 }) + tail, 'ok'],
  ['other-outcome', meta({ decision }, { stop: { ...meta({ decision }).stop, trigger: 'operator' } }), group({ other: 1 }) + tail, 'ok'],
  ['observed-no-decision', meta({ last_observation: { state: 'observed' } }), group({ observed: 1 }) + tail, 'ok'],
  ['not-observed', meta(), group({ unseen: 1 }) + tail, 'ok'],
];

for (const [name, value, text, status] of cases) {
  test(`${name} has exact cohort, status, and advice text`, () => {
    assert.deepEqual(row([record(value)]), check('silenceWatchdogShadow', status, text));
  });
}

test('all buckets are disjoint and all shadow buckets contribute to the group total', () => {
  assert.deepEqual(row(cases.map(([, value], index) => record(value, `run-${index}`))),
    check('silenceWatchdogShadow', 'warn',
      group({ count: 6, ok: 1, deadline: 1, other: 1, observed: 1, unseen: 1, faults: 1 })
      + ' [project/run-5]; outside the shadow cohort: off 1, armed 1, not recorded 1, unknown version 1' + review));
});

test('fault takes precedence over a valid or invalid decision, including a falsey non-null fault', () => {
  for (const fault of ['reader fault', '', false, 0]) {
    for (const candidate of [decision, { ...decision, action: 'stop' }]) {
      assert.deepEqual(row([record(meta({ fault, decision: candidate }, { status: 'OK' }))]),
        check('silenceWatchdogShadow', 'warn', group({ faults: 1 }) + tail + review));
    }
  }
});

test('versions are checked before arming and arming before faults or decisions', () => {
  for (const value of [meta({ arming: 'off', version: 2 }), meta({ arming: 'armed', version: 2 }),
    meta({ arming: 'off' }, { stop: { ...meta().stop, version: 1 } }),
    meta({ arming: 'unexpected', fault: 'fault', decision }), meta({ arming: null })]) {
    assert.deepEqual(row([record(value)]), check('silenceWatchdogShadow', 'warn',
      empty + tail.replace('unknown version 0', 'unknown version 1') + review));
  }
  for (const arming of ['off', 'armed']) {
    assert.deepEqual(row([record(meta({ arming, fault: 'fault', decision: {} }))]),
      check('silenceWatchdogShadow', 'ok', empty + tail.replace(`${arming} 0`, `${arming} 1`)));
  }
});

test('absent watchdog is not recorded even with an unknown stop version', () => {
  for (const stop of [undefined, null, 'not an object', 2, {}, { version: 1, watchdog: null }]) {
    assert.deepEqual(row([record({ stop })]), check('silenceWatchdogShadow', 'ok',
      empty + tail.replace('not recorded 0', 'not recorded 1')));
  }
});

const invalidDecisions = [
  ['action', { decision: { ...decision, action: 'stop' } }],
  ['missing action', { decision: { at: decision.at, confirmed_at: decision.confirmed_at, silence_ms: 1000 } }],
  ['at', { decision: { ...decision, at: 123 } }],
  ['confirmed_at', { decision: { ...decision, confirmed_at: null } }],
  ['missing confirmed_at', { decision: { action: 'recorded', at: decision.at, silence_ms: 1000 } }],
  ['string silence', { decision: { ...decision, silence_ms: '1000' } }],
  ['null silence', { decision: { ...decision, silence_ms: null } }],
  ['infinite silence', { decision: { ...decision, silence_ms: Infinity } }],
  ['NaN silence', { decision: { ...decision, silence_ms: NaN } }],
  ['checks', { decision, checks: 1 }],
  ['missing checks', { decision, checks: undefined }],
  ['fractional threshold', { decision, threshold_ms: 1.5 }],
  ['zero threshold', { decision, threshold_ms: 0 }],
  ['negative threshold', { decision, threshold_ms: -1 }],
  ['string threshold', { decision, threshold_ms: '1000' }],
  ['missing threshold', { decision, threshold_ms: undefined }],
  ['primitive decision', { decision: false }],
  ['empty decision', { decision: {} }],
];
for (const [name, watchdog] of invalidDecisions) {
  test(`invalid decision (${name}) is unknown, never observed or a false stop`, () => {
    assert.deepEqual(row([record(meta({ last_observation: { state: 'observed' }, ...watchdog }, { status: 'OK' }))]),
      check('silenceWatchdogShadow', 'warn', empty + tail.replace('unknown version 0', 'unknown version 1') + review));
  });
}

test('OK wins over deadline and outcome comes from meta, not status.json', () => {
  const value = record(meta({ decision }, { status: 'OK' }));
  value.status = { status: 'FAIL' };
  assert.deepEqual(row([value]), check('silenceWatchdogShadow', 'warn',
    group({ ok: 1 }) + ' [project/run]' + tail + review));
  const other = meta({ decision }, { status: 'FAIL' });
  delete other.stop.trigger;
  assert.deepEqual(row([record(other)]), check('silenceWatchdogShadow', 'ok', group({ other: 1 }) + tail));
});

test('no decision reports observed and unobserved states without warning', () => {
  for (const last_observation of [null, undefined, {}, { state: 'missing' }, { state: 'error' }]) {
    assert.deepEqual(row([record(meta({ decision: undefined, last_observation }))]),
      check('silenceWatchdogShadow', 'ok', group({ unseen: 1 }) + tail));
  }
  assert.deepEqual(row([record(meta()), record(meta({ last_observation: { state: 'observed' } }))]),
    check('silenceWatchdogShadow', 'ok', group({ count: 2, observed: 1, unseen: 1 }) + tail));
});

test('false-stop run list is sorted by run name, capped at five, and counts the remainder', () => {
  const records = ['z', 'b', 'g', 'a', 'f', 'e', 'd'].map((run, index) =>
    record(meta({ decision }, { status: 'OK' }), run, `project-${index}`));
  assert.deepEqual(row(records), check('silenceWatchdogShadow', 'warn',
    group({ count: 7, ok: 7 }) + ' [project-3/a, project-1/b, project-6/d, project-5/e, project-4/f, and 2 more]'
    + tail + review));
  assert.deepEqual(row(records.slice(0, 5)), check('silenceWatchdogShadow', 'warn',
    group({ count: 5, ok: 5 }) + ' [project-3/a, project-1/b, project-4/f, project-2/g, project-0/z]' + tail + review));
});

test('groups sort by role.phase and thresholds are distinct and sorted numerically', () => {
  const scout = meta({ threshold_ms: 500 }, { silence_policy: { role: 'scout', phase: 'default' } });
  assert.deepEqual(row([record(scout), record(meta({ threshold_ms: 2000 })),
    record(meta({ threshold_ms: 500 })), record(meta({ threshold_ms: 500 }))]),
  check('silenceWatchdogShadow', 'ok',
    group({ count: 3, unseen: 3, thresholds: '500/2000' }) + '; '
    + group({ key: 'scout.default', thresholds: '500', unseen: 1 }) + tail));
});

test('empty scan and records without meta objects are explicit rather than clean shadow evidence', () => {
  assert.deepEqual(row(), check('silenceWatchdogShadow', 'ok', empty + tail));
  assert.deepEqual(row([null, undefined, false, 1, 'OK'].map((value) => record(value))),
    check('silenceWatchdogShadow', 'ok', empty + tail));
  assert.deepEqual(row([], { days: 7 }), check('silenceWatchdogShadow', 'ok',
    'no shadow watchdog record in the last 7 days' + tail));
});

test('unreadable metadata suffix follows the cohort tail and precedes review advice', () => {
  assert.deepEqual(row([], { unreadable: 2 }), check('silenceWatchdogShadow', 'ok',
    empty + tail + ', 2 unreadable records skipped'));
  assert.deepEqual(row([record(meta({ fault: 'fault' }))], { unreadable: 1 }),
    check('silenceWatchdogShadow', 'warn', group({ faults: 1 }) + tail + ', 1 unreadable records skipped' + review));
});

test('scan errors warn verbatim and supplied records never scan the root', (t) => {
  t.mock.method(fs, 'readdirSync', () => assert.fail('supplied scan must not read the root'));
  t.mock.method(fs, 'readFileSync', () => assert.fail('supplied scan must not read metadata'));
  assert.deepEqual(silenceWatchdogShadowCheck({ runsRoot: '/unused', records: { error: 'runs root unavailable: fixture' } }),
    check('silenceWatchdogShadow', 'warn', 'runs root unavailable: fixture'));
  assert.deepEqual(row([record(meta())]), check('silenceWatchdogShadow', 'ok', group({ unseen: 1 }) + tail));
});

test('runsRoot path uses the shared scan and respects the lookback window', async () => {
  await withTempTree('watchdog-shadow-', (root) => {
    for (const run of ['2026-10-14_100000', '2026-10-01_100000']) {
      const folder = path.join(root, 'project', run);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta({ decision })), 'utf8');
    }
    assert.deepEqual(silenceWatchdogShadowCheck({ runsRoot: root, now: new Date('2026-10-15T12:00:00'), days: 2 }),
      check('silenceWatchdogShadow', 'ok', group({ deadline: 1 }) + tail));
  });
});
