/** Guards Plan_80 E15 (2), E19 and arbiter A12 recovery-budget evidence. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryBudgetDriftCheck } from '../../cli/doctor-recovery-budget-drift.mjs';
import { withTempTree } from '../temp-tree.mjs';
import { automaticChildMarker } from '../../src/home/lib/meta/pre-start.mjs';
import { RECOVERY_CALIBRATIONS, deriveRecoveryBudgetMs } from '../../src/home/lib/recovery-policy.mjs';

const budget = deriveRecoveryBudgetMs(RECOVERY_CALIBRATIONS['advisor.advise']);
const missingRoot = path.join(os.tmpdir(), `recovery-drift-missing-${process.pid}-${Date.now()}`);
const parent = '2026-10-15_120000';
const automaticStatus = { resumed_from: parent, recovery: { automatic: true, attempt: 2, parent } };
const release = '; change the budget and its evidence in recovery-policy.mjs together, then release';
const upward = '; children ran into their recovery budget: investigate and recalibrate upward';
const unknown = '; inspect run records of an unknown version';
let serial = 0;

function child({ policy = {}, stop = {}, outcome = 'OK', status = automaticStatus } = {}) {
  return {
    runDir: path.join(missingRoot, String(serial++)), status,
    meta: {
      status: outcome,
      recovery_policy: { version: 1, role: 'advisor', phase: 'advise', budget_ms: budget,
        calibration: { id: 'fixture' }, ...policy },
      stop: { version: 2, elapsed_ms: 100_001, trigger: 'completed', ...stop },
    },
  };
}

function inspect(records, extra = {}) {
  return recoveryBudgetDriftCheck({ records: { records, days: 30, unreadable: 0, ...extra } });
}

function cohort({ key = 'advisor.advise', ms = budget, id = 'fixture', n = 1,
  ok = 1, longest = 100_001, deadline = 0, other = 0, incomplete = 0 } = {}) {
  return `${key} budget ${ms} ms (calibration ${id}): ${n} children — OK ${ok}`
    + (ok > 0 ? ` (longest ${longest} ms)` : '')
    + `, deadline ${deadline}, other outcome ${other}, incomplete ${incomplete}`;
}

function downward(n = 20, candidate = 121_000, key = 'advisor.advise') {
  return `; ${n} complete successful children in ${key} support ${candidate} ms: review the cohort and recalibrate downward`;
}

function successful(n, options) {
  return Array.from({ length: n }, () => child(options));
}

test('empty evidence names the unexercised window and skips manual resumes and null statuses', () => {
  assert.equal(automaticChildMarker(automaticStatus), true);
  const manual = { resumed_from: parent };
  assert.equal(automaticChildMarker(manual), false);
  assert.deepEqual(inspect([child({ status: manual }), child({ status: null })], { days: 7 }), {
    key: 'recoveryBudgetDrift', status: 'ok', value: 'automatic recovery not exercised in the last 7 days',
  });
  assert.equal(inspect([]).value, 'automatic recovery not exercised in the last 30 days');
});

test('all cohort buckets and longest successful elapsed time are reported exactly', () => {
  const result = inspect([
    child({ stop: { elapsed_ms: 200_000 } }), child(),
    child({ stop: { trigger: 'deadline', elapsed_ms: budget } }),
    child({ outcome: 'FAIL' }), child({ stop: { elapsed_ms: -1 } }),
  ]);
  assert.deepEqual(result, { key: 'recoveryBudgetDrift', status: 'warn',
    value: cohort({ n: 5, ok: 2, longest: 200_000, deadline: 1, other: 1, incomplete: 1 }) + upward + release });
  assert.equal(inspect([child({ outcome: 'FAIL' })]).value, cohort({ ok: 0, other: 1 }));
});

test('not-started wins over versions, incomplete evidence, deadline and OK using one real tree', async () => {
  await withTempTree('recovery-drift-pre-start-', async (root) => {
    fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify({ ...automaticStatus, state: 'aborted_pre_start' }));
    const record = child({ policy: { version: 99, budget_ms: 0 }, stop: { version: 99, elapsed_ms: -1, trigger: 'deadline' } });
    record.runDir = root;
    assert.deepEqual(inspect([record]), { key: 'recoveryBudgetDrift', status: 'ok', value: '; not started 1' });
    const mixed = inspect([record, child({ policy: { version: 2 } }), child()]);
    assert.equal(mixed.value, cohort() + '; not started 1; unknown version 1' + unknown);
    assert.equal(mixed.status, 'warn');
  });
});

test('unknown versions precede incomplete and deadline, are outside cohorts, and never look clean', () => {
  const records = [
    child({ policy: { version: 2, budget_ms: 0 }, stop: { elapsed_ms: -1, trigger: 'deadline' } }),
    child({ stop: { version: 1, trigger: 'deadline' } }),
    child({ policy: { version: undefined } }), child({ stop: { version: undefined } }),
    { ...child(), meta: null }, { ...child(), meta: {} },
  ];
  assert.deepEqual(inspect(records), { key: 'recoveryBudgetDrift', status: 'warn',
    value: '; unknown version 6' + unknown });
});

test('invalid budgets are incomplete before deadline and OK', () => {
  for (const budget_ms of [undefined, null, 0, -1, 1.5, NaN, Infinity, '1000']) {
    const result = inspect([child({ policy: { budget_ms }, stop: { trigger: 'deadline' } })]);
    assert.equal(result.status, 'ok');
    assert.equal(result.value, `advisor.advise budget ${budget_ms} ms (calibration fixture): `
      + '1 children — OK 0, deadline 0, other outcome 0, incomplete 1');
  }
});

test('invalid elapsed values are incomplete before deadline and OK; zero elapsed is complete', () => {
  for (const elapsed_ms of [undefined, null, -1, NaN, Infinity, -Infinity, '1000']) {
    assert.deepEqual(inspect([child({ stop: { elapsed_ms, trigger: 'deadline' } })]), {
      key: 'recoveryBudgetDrift', status: 'ok', value: cohort({ ok: 0, incomplete: 1 }),
    });
  }
  assert.equal(inspect([child({ stop: { elapsed_ms: 0 } })]).value, cohort({ longest: 0 }));
});

test('deadline trigger precedes OK, while elapsed overage alone stays OK', () => {
  assert.equal(inspect([child({ stop: { trigger: 'deadline', elapsed_ms: 0 } })]).value,
    cohort({ ok: 0, deadline: 1 }) + upward + release);
  assert.deepEqual(inspect([child({ stop: { elapsed_ms: budget + 1 } })]), {
    key: 'recoveryBudgetDrift', status: 'ok', value: cohort({ longest: budget + 1 }),
  });
});

test('cohorts split by role.phase, budget and calibration id and sort deterministically', () => {
  const result = inspect([
    child({ policy: { role: 'writer', phase: 'draft' } }),
    child({ policy: { budget_ms: budget + 1 } }),
    child({ policy: { calibration: { id: 'z' } } }),
    child({ policy: { calibration: null } }), child(), child(),
  ]);
  assert.equal(result.value, [cohort({ n: 2, ok: 2 }), cohort({ id: 'none' }), cohort({ id: 'z' }),
    cohort({ ms: budget + 1 }), cohort({ key: 'writer.draft' })].join('; '));
  assert.equal(result.status, 'ok');
  assert.equal(inspect([child({ policy: { calibration: {} } })]).value, cohort({ id: 'none' }));
});

test('arbiter A12 boundary is nineteen versus twenty complete OK children and rounds upward', () => {
  assert.deepEqual(inspect(successful(19)), {
    key: 'recoveryBudgetDrift', status: 'ok', value: cohort({ n: 19, ok: 19 }),
  });
  assert.deepEqual(inspect(successful(20)), {
    key: 'recoveryBudgetDrift', status: 'warn', value: cohort({ n: 20, ok: 20 }) + downward() + release,
  });
  const exact = inspect(successful(20, { stop: { elapsed_ms: 100_000 } }));
  assert.equal(exact.value, cohort({ n: 20, ok: 20, longest: 100_000 }) + downward(20, 120_000) + release);
});

test('a deadline or incomplete child blocks downward advice for its cohort', () => {
  const deadline = inspect([...successful(20), child({ stop: { trigger: 'deadline' } })]);
  assert.equal(deadline.value, cohort({ n: 21, ok: 20, deadline: 1 }) + upward + release);
  const incomplete = inspect([...successful(20), child({ stop: { elapsed_ms: NaN } })]);
  assert.deepEqual(incomplete, { key: 'recoveryBudgetDrift', status: 'ok',
    value: cohort({ n: 21, ok: 20, incomplete: 1 }) });
  const other = inspect([...successful(20), child({ outcome: 'FAIL' })]);
  assert.equal(other.value, cohort({ n: 21, ok: 20, other: 1 }) + downward() + release);
});

test('cohort budgets and calibration ids cannot pool children to meet the downward minimum', () => {
  const byBudget = inspect([...successful(10), ...successful(10, { policy: { budget_ms: budget + 1 } })]);
  assert.equal(byBudget.status, 'ok');
  assert.equal(byBudget.value, [cohort({ n: 10, ok: 10 }), cohort({ n: 10, ok: 10, ms: budget + 1 })].join('; '));
  const byId = inspect([...successful(10), ...successful(10, { policy: { calibration: { id: 'other' } } })]);
  assert.equal(byId.status, 'ok');
  assert.equal(byId.value, [cohort({ n: 10, ok: 10 }), cohort({ n: 10, ok: 10, id: 'other' })].join('; '));
});

test('candidate must be strictly below both recorded and current package budgets', () => {
  for (const budget_ms of [120_000, 119_000]) {
    const result = inspect(successful(20, { policy: { budget_ms }, stop: { elapsed_ms: 100_000 } }));
    assert.equal(result.status, 'ok');
    assert.equal(result.value, cohort({ n: 20, ok: 20, ms: budget_ms, longest: 100_000 }));
  }
  for (const elapsed_ms of [918_000, budget]) {
    const result = inspect(successful(20, { policy: { budget_ms: budget * 2 }, stop: { elapsed_ms } }));
    assert.equal(result.status, 'ok');
    assert.equal(result.value, cohort({ n: 20, ok: 20, ms: budget * 2, longest: elapsed_ms }));
  }
  const noCalibration = inspect(successful(20, { policy: { role: 'writer', phase: 'draft' } }));
  assert.equal(noCalibration.status, 'ok');
  assert.equal(noCalibration.value, cohort({ key: 'writer.draft', n: 20, ok: 20 }));
});

test('longest OK child controls candidate while other-outcome elapsed does not', () => {
  const result = inspect([...successful(20), child({ stop: { elapsed_ms: 200_001 } }),
    child({ outcome: 'FAIL', stop: { elapsed_ms: budget * 2 } })]);
  assert.equal(result.value, cohort({ n: 22, ok: 21, longest: 200_001, other: 1 })
    + downward(21, 241_000) + release);
});

test('warning sentences follow upward, downward, unknown and release order byte for byte', () => {
  const result = inspect([...successful(20), child({ policy: { calibration: { id: 'blocked' } },
    stop: { trigger: 'deadline' } }), child({ stop: { version: 3 } })], { unreadable: 2 });
  assert.deepEqual(result, { key: 'recoveryBudgetDrift', status: 'warn', value:
    cohort({ id: 'blocked', ok: 0, deadline: 1 }) + '; ' + cohort({ n: 20, ok: 20 })
    + '; unknown version 1, 2 unreadable records skipped' + upward + downward() + unknown + release });
});

test('each qualifying cohort gets its own downward warning in cohort order', () => {
  const result = inspect([...successful(20, { policy: { calibration: { id: 'z' } } }), ...successful(20)]);
  assert.equal(result.value, cohort({ n: 20, ok: 20 }) + '; ' + cohort({ n: 20, ok: 20, id: 'z' })
    + downward() + downward() + release);
});

test('only meta unreadable counts supply the shared-scan suffix', () => {
  assert.equal(inspect([], { unreadable: 3, statusUnreadable: 8 }).value,
    'automatic recovery not exercised in the last 30 days, 3 unreadable records skipped');
  assert.equal(inspect([child()], { unreadable: 2 }).value, cohort() + ', 2 unreadable records skipped');
  assert.equal(inspect([child()], { statusUnreadable: 2 }).value, cohort());
});

test('scan errors warn without accessing records, and absent injected records use the scanner', () => {
  assert.deepEqual(recoveryBudgetDriftCheck({ records: { error: 'fixture scan unavailable' } }), {
    key: 'recoveryBudgetDrift', status: 'warn', value: 'fixture scan unavailable',
  });
  const result = recoveryBudgetDriftCheck({ runsRoot: missingRoot });
  assert.equal(result.key, 'recoveryBudgetDrift');
  assert.equal(result.status, 'warn');
  assert.match(result.value, /^runs root unavailable: /);
});
