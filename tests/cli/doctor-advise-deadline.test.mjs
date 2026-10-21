/** Guards advise deadline feedback under Plan_80 E32 and E35. */
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adviseDeadlineCheck } from '../../cli/doctor-advise-deadline.mjs';
import { diagnose } from '../../cli/doctor.mjs';
import { check } from '../../cli/doctor-format.mjs';
import { withTempTree } from '../temp-tree.mjs';
import { codexProbe, installedFixture, ownPackage, runsRootFixture } from './doctor-fixtures.mjs';

const currentBudgetMinutes = 37;
const now = new Date(2026, 9, 21, 12).getTime();
let serial = 0;

function record(root, { budget = currentBudgetMinutes, meta = {}, worker = true } = {}) {
  const runDir = path.join(root, 'project', `2026-10-20_120000-${serial++}`);
  fs.mkdirSync(runDir, { recursive: true });
  if (worker) fs.writeFileSync(path.join(runDir, 'worker.json'), JSON.stringify({ budget_minutes: budget }));
  return { runDir, meta: {
    agent: 'codex-advisor', phase: 'advise', status: 'FAIL', stop: { trigger: 'deadline' },
    situation: { kind: 'recent-activity' }, ...meta,
  } };
}

function row(records, extra = {}) {
  return adviseDeadlineCheck({ currentBudgetMinutes, records: { records, days: 30, unreadable: 0, ...extra } });
}

function group(label = 'current budget', budget = currentBudgetMinutes, recent = 0, stalled = 0, other = 0) {
  return `${label} ${budget} min: recent-activity ${recent}, silent-stall-candidate ${stalled}, other ${other}`;
}

function value(current = group(), days = 30) {
  return `advise passes stopped by the deadline in the last ${days} days — ${current}`;
}

function warning(count, budget = currentBudgetMinutes) {
  return `; ${count} healthy slow advise passes were killed by the ${budget}-minute deadline: `
    + 'consider the 45-minute fallback for advise in src/home/lib/agents.mjs (Plan_80 E32), then release';
}

test('empty supplied evidence always prints the current group without scanning or reading home config', (t) => {
  t.mock.method(fs, 'readdirSync', () => assert.fail('supplied records must not scan'));
  t.mock.method(fs, 'readFileSync', () => assert.fail('empty evidence must not read files'));
  assert.deepEqual(row([]), check('adviseDeadline', 'ok', value()));
  assert.deepEqual(row([], { days: 7 }), check('adviseDeadline', 'ok', value(group(), 7)));
});

for (const count of [2, 3, 4]) {
  test(`${count} current-budget recent-activity passes obey the E35 threshold and exact suffix`, async () => {
    await withTempTree('advise-deadline-threshold-', (root) => {
      const entries = Array.from({ length: count }, () => record(root));
      assert.deepEqual(row(entries), check('adviseDeadline', count < 3 ? 'ok' : 'warn',
        value(group('current budget', currentBudgetMinutes, count)) + (count < 3 ? '' : warning(count))));
    });
  });
}

test('earlier budgets never warn and groups sort numerically after the zero current group', async () => {
  await withTempTree('advise-deadline-earlier-', (root) => {
    const entries = [25, 9, 25, 100, 25].map((budget) => record(root, { budget }));
    assert.deepEqual(row(entries), check('adviseDeadline', 'ok', value()
      + '; ' + group('earlier budget', 9, 1)
      + '; ' + group('earlier budget', 25, 3)
      + '; ' + group('earlier budget', 100, 1)));
  });
});

test('stalled and other current-budget passes never trigger a warning', async () => {
  await withTempTree('advise-deadline-kinds-', (root) => {
    const kinds = ['silent-stall-candidate', 'silent-stall-candidate', 'silent-stall-candidate',
      'unknown', 'other', 'constructor', undefined];
    const entries = kinds.map((kind) => record(root, { meta: { situation: kind === undefined ? undefined : { kind } } }));
    assert.deepEqual(row(entries), check('adviseDeadline', 'ok',
      value(group('current budget', currentBudgetMinutes, 0, 3, 4))));
  });
});

test('earlier activity, stalls and other outcomes cannot pool toward the current activity threshold', async () => {
  await withTempTree('advise-deadline-no-pooling-', (root) => {
    const entries = [record(root), record(root), record(root, { budget: 25 }),
      record(root, { meta: { situation: { kind: 'silent-stall-candidate' } } }),
      record(root, { meta: { situation: null } })];
    assert.deepEqual(row(entries), check('adviseDeadline', 'ok',
      value(group('current budget', currentBudgetMinutes, 2, 1, 1)) + '; ' + group('earlier budget', 25, 1)));
  });
});

test('non-advisor, scope phase, non-deadline and non-FAIL metadata are ignored before worker reads', (t) => {
  const ignored = [{ agent: 'codex-build' }, { phase: 'scope' }, { status: 'OK' },
    { status: 'LIMIT' }, { stop: { trigger: 'completed' } }, { stop: null }];
  const base = { agent: 'codex-advisor', phase: 'advise', status: 'FAIL', stop: { trigger: 'deadline' } };
  t.mock.method(fs, 'readFileSync', () => assert.fail('ignored records must not read worker files'));
  const entries = [{ meta: null }, { meta: {} }, ...ignored.map((meta) => ({ meta: { ...base, ...meta } }))];
  assert.deepEqual(row(entries), check('adviseDeadline', 'ok', value()));
});

test('missing, unreadable, corrupt and invalid worker budgets stay unknown without warning', async (t) => {
  await withTempTree('advise-deadline-unknown-', (root) => {
    const entries = [record(root, { worker: false }),
      ...[undefined, null, 0, -1, '37', false, Infinity].map((budget) => {
        const entry = record(root);
        fs.writeFileSync(path.join(entry.runDir, 'worker.json'), JSON.stringify({ budget_minutes: budget }));
        return entry;
      })];
    const corrupt = record(root);
    fs.writeFileSync(path.join(corrupt.runDir, 'worker.json'), '{');
    const denied = record(root);
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === path.join(denied.runDir, 'worker.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return read(file, ...args);
    });
    entries.push(corrupt, denied);
    assert.deepEqual(row(entries), check('adviseDeadline', 'ok', value() + `; budget unknown ${entries.length}`));
  });
});

test('BOM worker JSON and positive fractional allocations are read without rounding', async () => {
  await withTempTree('advise-deadline-bom-', (root) => {
    const entry = record(root, { budget: 25.5 });
    fs.writeFileSync(path.join(entry.runDir, 'worker.json'), '\uFEFF{"budget_minutes":25.5}');
    assert.deepEqual(row([entry]), check('adviseDeadline', 'ok', value() + '; ' + group('earlier budget', 25.5, 1)));
  });
});

test('scan errors warn verbatim without reading any files', (t) => {
  t.mock.method(fs, 'readFileSync', () => assert.fail('scan errors must not read config or workers'));
  const error = 'runs root unavailable: fixture denied';
  assert.deepEqual(adviseDeadlineCheck({ records: { error }, currentBudgetMinutes }),
    check('adviseDeadline', 'warn', error));
});

test('unreadable metadata count is appended before the exact warning; status unreadability is ignored', async () => {
  await withTempTree('advise-deadline-unreadable-', (root) => {
    assert.deepEqual(row([], { unreadable: 2, statusUnreadable: 9 }),
      check('adviseDeadline', 'ok', value() + ', 2 unreadable records skipped'));
    const entries = Array.from({ length: 3 }, () => record(root));
    assert.deepEqual(row(entries, { unreadable: 1 }), check('adviseDeadline', 'warn',
      value(group('current budget', currentBudgetMinutes, 3)) + ', 1 unreadable records skipped' + warning(3)));
  });
});

test('without supplied records the shared scanner honors the requested lookback window', async () => {
  await withTempTree('advise-deadline-scan-', (root) => {
    const recent = record(root);
    fs.writeFileSync(path.join(recent.runDir, 'meta.json'), JSON.stringify(recent.meta));
    const oldDir = path.join(root, 'project', '2026-10-01_120000');
    fs.mkdirSync(oldDir);
    fs.writeFileSync(path.join(oldDir, 'meta.json'), JSON.stringify(recent.meta));
    fs.writeFileSync(path.join(oldDir, 'worker.json'), JSON.stringify({ budget_minutes: currentBudgetMinutes }));
    assert.deepEqual(adviseDeadlineCheck({ runsRoot: root, now, days: 7, currentBudgetMinutes }),
      check('adviseDeadline', 'ok', value(group('current budget', currentBudgetMinutes, 1), 7)));
    const missing = adviseDeadlineCheck({ runsRoot: path.join(root, 'missing'), now, currentBudgetMinutes });
    assert.equal(missing.status, 'warn');
    assert.match(missing.value, /^runs root unavailable: .*ENOENT/);
  });
});

test('doctor shares the same scan after recoveryEnablingGates and an advise warning leaves exit code unchanged', async (t) => {
  const { host } = await installedFixture(t);
  const root = await runsRootFixture(t);
  for (let index = 0; index < 3; index += 1) {
    const entry = record(root);
    fs.writeFileSync(path.join(entry.runDir, 'meta.json'), JSON.stringify(entry.meta));
  }
  const options = { host, codexProbe, bridgeProbe: codexProbe, currentPackage: ownPackage, now };
  const baseline = await diagnose(options);
  assert.equal(baseline.exitCode, 0);
  let shared;
  const result = await diagnose({ ...options,
    recoveryEnablingGates: ({ records }) => {
      shared = records;
      return check('recoveryEnablingGates', 'ok', 'fixture');
    },
    adviseDeadline: (args) => {
      assert.strictEqual(args.records, shared);
      return adviseDeadlineCheck({ ...args, currentBudgetMinutes });
    },
  });
  const index = result.checks.findIndex(({ key }) => key === 'recoveryEnablingGates');
  assert.deepEqual(result.checks[index + 1], check('adviseDeadline', 'warn',
    value(group('current budget', currentBudgetMinutes, 3)) + warning(3)));
  assert.equal(result.exitCode, baseline.exitCode);
});
