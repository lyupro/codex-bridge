/** Guards Plan_80 E12: package calibration drift must warn before a healthy run is called stalled. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { silenceCalibrationCheck } from '../../cli/doctor-silence-calibration.mjs';
import { silenceWatchdogShadowCheck } from '../../cli/doctor-silence-watchdog-shadow.mjs';
import { diagnose } from '../../cli/doctor.mjs';
import { check } from '../../cli/doctor-format.mjs';
import { installedFixture, codexProbe, ownPackage } from './doctor-fixtures.mjs';
import { withTempTree } from '../temp-tree.mjs';

const now = new Date('2026-10-15T12:00:00');
const recent = '2026-10-14_100000';
const empty = 'no successful run with recorded pauses in the last 30 days';
const recalibrate = '; recalibrate: measure the longest quiet pause of successful runs from Codex session logs and change the threshold together with its evidence in silence-policy.mjs, then release';

function successful(gap = 900000, policy = {}) {
  return {
    status: 'OK',
    silence_policy: { role: 'advisor', phase: 'advise', threshold_ms: 996000, ...policy },
    stop: { session: { longest_quiet_gap_ms: gap } },
  };
}

function record(root, name, meta, project = 'project') {
  const folder = path.join(root, project, name);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'meta.json');
  fs.writeFileSync(file, typeof meta === 'string' ? meta : JSON.stringify(meta));
  return file;
}

function row(root, options = {}) {
  return silenceCalibrationCheck({ runsRoot: root, now, ...options });
}

test('empty runs root is ok with no successful runs', async () => {
  await withTempTree('silence-empty-', (root) => {
    assert.deepEqual(row(root), check('silenceCalibration', 'ok', empty));
  });
});

test('missing runs root warns with the reason instead of throwing', async () => {
  await withTempTree('silence-missing-', (root) => {
    const result = row(path.join(root, 'missing'));
    assert.equal(result.key, 'silenceCalibration');
    assert.equal(result.status, 'warn');
    assert.match(result.value, /ENOENT/);
  });
});

test('unreadable runs root warns with the reason instead of throwing', async (t) => {
  await withTempTree('silence-unreadable-', (root) => {
    const read = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (folder, options) => {
      if (folder === root) throw Object.assign(new Error('EACCES: calibration root denied'), { code: 'EACCES' });
      return read(folder, options);
    });
    const result = row(root);
    assert.equal(result.status, 'warn');
    assert.match(result.value, /EACCES: calibration root denied/);
  });
});

test('successful advise below its threshold reports zero of one and the longest pause', async () => {
  await withTempTree('silence-below-', (root) => {
    record(root, recent, successful());
    assert.deepEqual(row(root), check('silenceCalibration', 'ok',
      'advisor.advise: 0 of 1 successful runs reached 996000 ms (longest quiet pause 900000 ms)'));
  });
});

for (const gap of [996000, 1000000]) {
  test(`successful advise at ${gap} ms warns at or above its frozen threshold`, async () => {
    await withTempTree('silence-breach-', (root) => {
      record(root, recent, successful(gap));
      assert.deepEqual(row(root), check('silenceCalibration', 'warn',
        `advisor.advise: 1 of 1 successful runs reached 996000 ms (longest quiet pause ${gap} ms)${recalibrate}`));
    });
  });
}

test('FAIL, null or nonnumeric thresholds, and absent or nonnumeric pauses are not counted', async () => {
  await withTempTree('silence-ineligible-', (root) => {
    const records = [
      { ...successful(2000000), status: 'FAIL' },
      successful(2000000, { threshold_ms: null }),
      successful(2000000, { threshold_ms: '996000' }),
      { ...successful(), stop: {} },
      successful(null),
      successful('2000000'),
      null,
    ];
    records.forEach((meta, index) => record(root, `${recent}-${index}`, meta));
    assert.deepEqual(row(root), check('silenceCalibration', 'ok', empty));
  });
});

test('older than 30 days, future, and non-timestamp folders are ignored before metadata is read', async () => {
  await withTempTree('silence-window-', (root) => {
    record(root, '2026-09-15_115959', '{');
    record(root, '2026-10-15_120001', '{');
    record(root, 'not-a-run', '{');
    assert.deepEqual(row(root), check('silenceCalibration', 'ok', empty));
  });
});

test('the 30-day lower boundary is included and timestamp suffixes are accepted', async () => {
  await withTempTree('silence-window-boundary-', (root) => {
    record(root, '2026-09-15_120000-advisor', successful());
    assert.equal(row(root).value,
      'advisor.advise: 0 of 1 successful runs reached 996000 ms (longest quiet pause 900000 ms)');
  });
});

test('days changes the lookback window and the empty message', async () => {
  await withTempTree('silence-days-', (root) => {
    record(root, '2026-10-10_100000', successful(2000000));
    assert.deepEqual(row(root, { days: 2 }), check('silenceCalibration', 'ok',
      'no successful run with recorded pauses in the last 2 days'));
  });
});

test('an unparseable meta.json is counted as skipped, a missing one (live or abandoned run) is not', async () => {
  await withTempTree('silence-skipped-', (root) => {
    record(root, `${recent}-broken`, '{');
    fs.mkdirSync(path.join(root, 'project', `${recent}-missing`));
    assert.deepEqual(row(root), check('silenceCalibration', 'ok', `${empty}, 1 unreadable records skipped`));
  });
});

test('a meta.json with a byte-order mark is read like the rest of the package reads JSON', async () => {
  await withTempTree('silence-bom-', (root) => {
    record(root, recent, `﻿${JSON.stringify(successful(996000))}`);
    assert.equal(row(root).status, 'warn');
  });
});

test('unreadable meta.json is skipped and appended after the recalibration advice', async (t) => {
  await withTempTree('silence-denied-record-', (root) => {
    record(root, recent, successful(996000));
    const denied = record(root, `${recent}-denied`, successful());
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === denied) throw Object.assign(new Error('EACCES: record denied'), { code: 'EACCES' });
      return read(file, ...args);
    });
    assert.deepEqual(row(root), check('silenceCalibration', 'warn',
      `advisor.advise: 1 of 1 successful runs reached 996000 ms (longest quiet pause 996000 ms)${recalibrate}, 1 unreadable records skipped`));
  });
});

test('advisor.advise and scout.default groups have stable order, counts, and maxima across projects', async () => {
  await withTempTree('silence-groups-', (root) => {
    record(root, recent, successful(100, { role: 'scout', phase: 'default', threshold_ms: 200 }), 'a-scout');
    record(root, recent, successful(996000), 'z-advisor');
    record(root, `${recent}-second`, successful(900000), 'z-advisor');
    assert.deepEqual(row(root), check('silenceCalibration', 'warn',
      'advisor.advise: 1 of 2 successful runs reached 996000 ms (longest quiet pause 996000 ms); '
      + `scout.default: 0 of 1 successful runs reached 200 ms (longest quiet pause 100 ms)${recalibrate}`));
  });
});

test('each successful run is compared with its own frozen threshold within the same group', async () => {
  await withTempTree('silence-frozen-', (root) => {
    record(root, recent, successful(100, { threshold_ms: 100 }));
    record(root, `${recent}-second`, successful(200, { threshold_ms: 300 }));
    assert.deepEqual(row(root), check('silenceCalibration', 'warn',
      `advisor.advise: 1 of 2 successful runs reached 100/300 ms (longest quiet pause 200 ms)${recalibrate}`));
  });
});

test('.git and nondirectory entries at project and run levels are ignored', async () => {
  await withTempTree('silence-entries-', (root) => {
    record(root, recent, successful(2000000), '.git');
    fs.writeFileSync(path.join(root, 'plain-file'), 'not a directory');
    fs.mkdirSync(path.join(root, 'project', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'project', recent), 'not a directory');
    assert.deepEqual(row(root), check('silenceCalibration', 'ok', empty));
  });
});

test('the check writes nothing while reading run records', async (t) => {
  await withTempTree('silence-read-only-', (root) => {
    const file = record(root, recent, successful());
    const before = fs.readFileSync(file, 'utf8');
    const mocks = ['writeFileSync', 'mkdirSync', 'renameSync', 'rmSync'].map((name) =>
      t.mock.method(fs, name, () => assert.fail(`calibration must not call ${name}`)));
    try {
      assert.equal(row(root).status, 'ok');
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    } finally {
      for (const mock of mocks) mock.mock.restore();
    }
  });
});

test('diagnose shares one runs-root resolution, inserts four evidence rows after projectRuns, and preserves exit code', async (t) => {
  const { host } = await installedFixture(t);
  await withTempTree('silence-diagnose-', async (root) => {
    const previous = { CODEX_BRIDGE_HOME: process.env.CODEX_BRIDGE_HOME, CODEX_RUNS_ROOT: process.env.CODEX_RUNS_ROOT };
    process.env.CODEX_BRIDGE_HOME = root;
    process.env.CODEX_RUNS_ROOT = path.join(root, 'runs');
    fs.mkdirSync(process.env.CODEX_RUNS_ROOT);
    const options = {
      host, codexProbe, currentPackage: ownPackage,
      bridgeProbe: () => ({ available: true, value: 'fixture' }),
      hostVersion: null, contractRecord: null, handbackWitnessRecord: null,
      dispatcherModelRecord: null, dispatcherContractRecord: null, observations: [], now,
    };
    try {
      const baseline = await diagnose(options);
      assert.ok(!baseline.checks.some(({ key }) => ['silenceCalibration', 'silenceWatchdogShadow', 'recoveryBudgetDrift', 'recoveryEnablingGates'].includes(key)));
      const disabled = await diagnose({ ...options, silenceCalibration: true, silenceWatchdogShadow: true, recoveryBudgetDrift: true, recoveryEnablingGates: true });
      assert.ok(!disabled.checks.some(({ key }) => ['silenceCalibration', 'silenceWatchdogShadow', 'recoveryBudgetDrift', 'recoveryEnablingGates'].includes(key)));
      const moveFile = path.join(root, 'state', 'runs-root.json');
      const read = fs.readFileSync;
      let resolutions = 0;
      const readMock = t.mock.method(fs, 'readFileSync', (file, ...args) => {
        if (file === moveFile) resolutions += 1;
        return read(file, ...args);
      });
      let calls = 0;
      let shadowCalls = 0;
      let driftCalls = 0;
      let gateCalls = 0;
      let sharedRecords;
      const result = await diagnose({ ...options, silenceCalibration: async (input) => {
        calls += 1;
        sharedRecords = input.records;
        assert.deepEqual(input, { runsRoot: process.env.CODEX_RUNS_ROOT, now, records: {
          records: [], unreadable: 0, statusUnreadable: 0, days: 30,
          windowStart: now.getTime() - 30 * 24 * 60 * 60 * 1000, windowEnd: now.getTime(),
        } });
        return check('silenceCalibration', 'warn', 'fixture calibration breach');
      }, silenceWatchdogShadow: async (input) => {
        shadowCalls += 1;
        assert.strictEqual(input.records, sharedRecords);
        assert.equal(input.runsRoot, process.env.CODEX_RUNS_ROOT);
        assert.equal(input.now, now);
        return check('silenceWatchdogShadow', 'warn', 'fixture false stop');
      }, recoveryBudgetDrift: async (input) => {
        driftCalls += 1;
        assert.strictEqual(input.records, sharedRecords);
        assert.equal(input.runsRoot, process.env.CODEX_RUNS_ROOT);
        assert.equal(input.now, now);
        return check('recoveryBudgetDrift', 'warn', 'fixture recovery drift');
      }, recoveryEnablingGates: async (input) => {
        gateCalls += 1;
        assert.strictEqual(input.records, sharedRecords);
        assert.equal(input.runsRoot, process.env.CODEX_RUNS_ROOT);
        assert.equal(input.now, now);
        return check('recoveryEnablingGates', 'warn', 'fixture enabling gate');
      } });
      readMock.mock.restore();
      assert.equal(calls, 1);
      assert.equal(shadowCalls, 1);
      assert.equal(driftCalls, 1);
      assert.equal(gateCalls, 1);
      assert.equal(resolutions, 1);
      assert.equal(result.exitCode, baseline.exitCode);
      const index = result.checks.findIndex(({ key }) => key === 'projectRuns');
      assert.deepEqual(result.checks[index + 1], check('silenceCalibration', 'warn', 'fixture calibration breach'));
      assert.deepEqual(result.checks[index + 2], check('silenceWatchdogShadow', 'warn', 'fixture false stop'));
      assert.deepEqual(result.checks[index + 3], check('recoveryBudgetDrift', 'warn', 'fixture recovery drift'));
      assert.deepEqual(result.checks[index + 4], check('recoveryEnablingGates', 'warn', 'fixture enabling gate'));

      fs.mkdirSync(path.dirname(moveFile), { recursive: true });
      for (const moveRecord of ['{', JSON.stringify({ version: 1, retired: [
        { root: process.env.CODEX_RUNS_ROOT, movedAt: '2026-10-14T00:00:00.000Z' },
      ] })]) {
        fs.writeFileSync(moveFile, moveRecord);
        const unavailable = await diagnose({ ...options,
          silenceCalibration: () => assert.fail('must not scan unavailable roots'),
          silenceWatchdogShadow: () => assert.fail('must not scan unavailable roots'),
          recoveryBudgetDrift: () => assert.fail('must not scan unavailable roots'),
          recoveryEnablingGates: () => assert.fail('must not scan unavailable roots'),
        });
        const runsRoot = unavailable.checks.find(({ key }) => key === 'runsRoot');
        const index = unavailable.checks.findIndex(({ key }) => key === 'projectRuns');
        assert.deepEqual(unavailable.checks[index + 1], check('silenceCalibration', 'warn', `unavailable: ${runsRoot.value}`));
        assert.deepEqual(unavailable.checks[index + 2], check('silenceWatchdogShadow', 'warn', `unavailable: ${runsRoot.value}`));
        assert.deepEqual(unavailable.checks[index + 3], check('recoveryBudgetDrift', 'warn', `unavailable: ${runsRoot.value}`));
        assert.deepEqual(unavailable.checks[index + 4], check('recoveryEnablingGates', 'warn', `unavailable: ${runsRoot.value}`));
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test('a supplied scan is used without touching a missing runs root', async (t) => {
  await withTempTree('silence-supplied-', (root) => {
    t.mock.method(fs, 'readdirSync', () => assert.fail('supplied records must not scan the root'));
    t.mock.method(fs, 'readFileSync', () => assert.fail('supplied records must not read files'));
    const records = {
      records: [{ meta: successful(996000) }], unreadable: 1, statusUnreadable: 2, days: 7,
      windowStart: now.getTime() - 7 * 24 * 60 * 60 * 1000, windowEnd: now.getTime(),
    };
    assert.deepEqual(row(path.join(root, 'missing'), { records }), check('silenceCalibration', 'warn',
      `advisor.advise: 1 of 1 successful runs reached 996000 ms (longest quiet pause 996000 ms)${recalibrate}, 1 unreadable records skipped`));
    assert.deepEqual(row(path.join(root, 'missing'), { records: { ...records, records: [], unreadable: 0 } }),
      check('silenceCalibration', 'ok', 'no successful run with recorded pauses in the last 7 days'));
    assert.deepEqual(row(path.join(root, 'missing'), { records: { error: 'runs root unavailable: fixture' } }),
      check('silenceCalibration', 'warn', 'runs root unavailable: fixture'));
  });
});

test('diagnose reads sampled metadata once and both evidence callbacks reuse the shared scan', async (t) => {
  const { host } = await installedFixture(t);
  await withTempTree('silence-shared-scan-', async (root) => {
    const previous = { CODEX_BRIDGE_HOME: process.env.CODEX_BRIDGE_HOME, CODEX_RUNS_ROOT: process.env.CODEX_RUNS_ROOT };
    process.env.CODEX_BRIDGE_HOME = root;
    process.env.CODEX_RUNS_ROOT = path.join(root, 'runs');
    const metaFile = record(process.env.CODEX_RUNS_ROOT, recent, successful());
    const options = {
      host, codexProbe, currentPackage: ownPackage,
      bridgeProbe: () => ({ available: true, value: 'fixture' }),
      hostVersion: null, contractRecord: null, handbackWitnessRecord: null,
      dispatcherModelRecord: null, dispatcherContractRecord: null, observations: [], now,
    };
    const read = fs.readFileSync;
    let metadataReads = 0;
    const readMock = t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === metaFile) metadataReads += 1;
      return read(file, ...args);
    });
    try {
      await diagnose(options);
      await diagnose({ ...options, silenceCalibration: true, silenceWatchdogShadow: true });
      assert.equal(metadataReads, 0, 'no evidence callback means no metadata scan');
      let sharedRecords;
      const result = await diagnose({ ...options, silenceCalibration: (input) => {
        sharedRecords = input.records;
        assert.equal(input.records.records.length, 1);
        assert.equal(input.records.records[0].runDir, path.dirname(metaFile));
        return silenceCalibrationCheck(input);
      }, silenceWatchdogShadow: (input) => {
        assert.strictEqual(input.records, sharedRecords);
        return silenceWatchdogShadowCheck(input);
      } });
      assert.equal(metadataReads, 1, 'both evidence callbacks must reuse the diagnose scan');
      const calibrationIndex = result.checks.findIndex(({ key }) => key === 'silenceCalibration');
      assert.deepEqual(result.checks[calibrationIndex + 1], check('silenceWatchdogShadow', 'ok',
        'no shadow watchdog record in the last 30 days; outside the shadow cohort: off 0, armed 0, not recorded 1, unknown version 0'));
      const shadowOnly = await diagnose({ ...options, silenceWatchdogShadow: silenceWatchdogShadowCheck });
      assert.equal(metadataReads, 2, 'shadow callback alone must request a scan');
      const projectIndex = shadowOnly.checks.findIndex(({ key }) => key === 'projectRuns');
      assert.deepEqual(shadowOnly.checks[projectIndex + 1], result.checks[calibrationIndex + 1]);
      assert.equal(shadowOnly.exitCode, result.exitCode);
      assert.deepEqual(result.checks.find(({ key }) => key === 'silenceCalibration'),
        check('silenceCalibration', 'ok',
          'advisor.advise: 0 of 1 successful runs reached 996000 ms (longest quiet pause 900000 ms)'));
      const moveFile = path.join(root, 'state', 'runs-root.json');
      fs.mkdirSync(path.dirname(moveFile), { recursive: true });
      for (const moveRecord of ['{', JSON.stringify({ version: 1, retired: [
        { root: process.env.CODEX_RUNS_ROOT, movedAt: '2026-10-14T00:00:00.000Z' },
      ] })]) {
        fs.writeFileSync(moveFile, moveRecord);
        await diagnose({ ...options,
          silenceCalibration: () => assert.fail('unusable roots must not invoke evidence'),
          silenceWatchdogShadow: () => assert.fail('unusable roots must not invoke evidence'),
        });
        assert.equal(metadataReads, 2, 'unusable roots must not scan metadata');
      }
    } finally {
      readMock.mock.restore();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
