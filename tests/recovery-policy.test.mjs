/**
 * Plan_80 S4/E9/E12/E15: recovery budgets travel with measured evidence, and enabling
 * automatic continuation requires a separate package decision plus both budgets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS } from '../src/home/lib/agents.mjs';
import { collect } from '../src/home/lib/write-meta.mjs';
import { withTempTree } from './temp-tree.mjs';
import {
  RECOVERY_CALIBRATIONS,
  AUTOMATIC_RECOVERY_ENABLED,
  deriveRecoveryBudgetMs,
  resolveRecoveryBrake,
  resolveRecoveryPolicy,
} from '../src/home/lib/recovery-policy.mjs';

const phasesOf = (entry) => typeof entry.budget === 'object' ? Object.keys(entry.budget) : ['default'];
const calibration = RECOVERY_CALIBRATIONS['advisor.advise'];

for (const [received, value, source] of [
  [undefined, 'on', 'default'], ['', 'on', 'default'], [' \t\n ', 'on', 'default'],
  ['on', 'on', 'env'], ['off', 'off', 'env'], [' off ', 'off', 'env'],
]) {
  test(`host brake resolves ${JSON.stringify(received)} without enabling the package switch`, () => {
    const env = received === undefined ? {} : { CODEX_BRIDGE_AUTO_RECOVERY: received };
    assert.deepEqual(resolveRecoveryBrake({ env }), { key: 'CODEX_BRIDGE_AUTO_RECOVERY', value, source });
    assert.equal(resolveRecoveryPolicy('codex-advisor', 'advise').enabled, false);
  });
}

for (const received of ['OFF', '0', 'false', 'yes']) {
  test(`host brake rejects ${JSON.stringify(received)} with an actionable diagnostic`, () => {
    assert.throws(() => resolveRecoveryBrake({ env: { CODEX_BRIDGE_AUTO_RECOVERY: received } }), (error) => {
      for (const part of ['CODEX_BRIDGE_AUTO_RECOVERY', 'env', JSON.stringify(received), 'on or off']) {
        assert.ok(error.message.includes(part), error.message);
      }
      return true;
    });
  });
}

test('host brake reads only the injected environment and only its own key', () => {
  const key = 'CODEX_BRIDGE_AUTO_RECOVERY';
  const previous = process.env[key];
  const reads = [];
  const env = new Proxy({ CODEX_BRIDGE_AUTO_RECOVERY: 'off' }, {
    get(target, key) { reads.push(key); return target[key]; },
  });
  try {
    process.env[key] = 'invalid ambient brake';
    assert.deepEqual(resolveRecoveryBrake({ env }), { key, value: 'off', source: 'env' });
    assert.deepEqual(reads, [key]);
    assert.deepEqual(resolveRecoveryBrake({ env: {} }), { key, value: 'on', source: 'default' });
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

for (const [agent, entry] of Object.entries(AGENTS)) {
  for (const phase of phasesOf(entry)) {
    test(`${agent}.${phase} resolves its explicit recovery policy with automatic recovery disabled`, () => {
      const calibrated = entry.role === 'advisor' && phase === 'advise';
      const policy = resolveRecoveryPolicy(agent, phase);
      assert.deepEqual(policy, {
        version: 1,
        role: entry.role,
        phase,
        budget_ms: calibrated ? 1102000 : null,
        enabled: false,
        calibration: calibrated ? calibration : null,
      });
      assert.equal(policy.calibration, calibrated ? calibration : null);
    });
  }
}

test('the frozen catalog retains the complete Plan_80 S4 evidence', () => {
  assert.ok(Object.isFrozen(RECOVERY_CALIBRATIONS));
  assert.ok(Object.isFrozen(calibration));
  assert.deepEqual(RECOVERY_CALIBRATIONS, {
    'advisor.advise': {
      id: 'plan80-s4-2026-10-15',
      measured_on: '2026-10-15',
      window: '2026-10-01..2026-10-15',
      codex_version: '0.160.1',
      sample_runs: 322,
      measure: 'last exec or read tool output to the final answer, Codex session log, successful runs',
      max_tail_ms: 917634,
      margin: 0.2,
      rule: 'ceil(max_tail_ms * (1 + margin) / 1000) * 1000',
    },
  });
});

test('the pure derivation gives 1102000 ms and covers every measured tail', () => {
  assert.equal(deriveRecoveryBudgetMs(calibration), 1102000);
  for (const record of Object.values(RECOVERY_CALIBRATIONS)) {
    assert.ok(deriveRecoveryBudgetMs(record) >= record.max_tail_ms);
  }
  // S4 rounds up to a second only after applying the margin, including exact boundaries.
  assert.equal(deriveRecoveryBudgetMs({ max_tail_ms: 1000, margin: 0 }), 1000);
  assert.equal(deriveRecoveryBudgetMs({ max_tail_ms: 1001, margin: 0 }), 2000);
  assert.equal(deriveRecoveryBudgetMs({ max_tail_ms: 2500, margin: 0.2 }), 3000);
});

test('registry budgets and catalog records cover one another in both directions', () => {
  const calibratedKeys = [];
  for (const [agent, entry] of Object.entries(AGENTS)) {
    for (const phase of phasesOf(entry)) {
      const value = typeof entry.budget === 'object' ? entry.recoveryBudgetMs[phase] : entry.recoveryBudgetMs;
      const key = `${entry.role}.${phase}`;
      assert.equal(Object.hasOwn(RECOVERY_CALIBRATIONS, key), value !== null, key);
      if (value !== null) {
        calibratedKeys.push(key);
        assert.equal(value, deriveRecoveryBudgetMs(RECOVERY_CALIBRATIONS[key]), key);
      }
      assert.equal(resolveRecoveryPolicy(agent, phase).calibration, RECOVERY_CALIBRATIONS[key] ?? null);
    }
  }
  assert.deepEqual(calibratedKeys.sort(), Object.keys(RECOVERY_CALIBRATIONS).sort());
});

test('the frozen package switch covers exactly the catalog and ships disabled under E15', () => {
  assert.ok(Object.isFrozen(AUTOMATIC_RECOVERY_ENABLED));
  assert.deepEqual(AUTOMATIC_RECOVERY_ENABLED, { 'advisor.advise': false });
  assert.deepEqual(Object.keys(AUTOMATIC_RECOVERY_ENABLED).sort(), Object.keys(RECOVERY_CALIBRATIONS).sort());
});

test('unknown agents, including inherited names, throw with an injected registry', () => {
  const registry = { probe: { role: 'scout', budget: 1, recoveryBudgetMs: null } };
  for (const agent of ['missing', 'toString', '__proto__']) {
    assert.throws(() => resolveRecoveryPolicy(agent, 'default', registry), /Unknown agent/);
  }
});

test('only budget-declared phases are accepted, including default for scalar budgets', () => {
  const registry = {
    scalar: { role: 'scout', budget: 1, recoveryBudgetMs: null },
    phased: { role: 'scout', budget: { scope: 1 }, recoveryBudgetMs: { scope: null, other: null } },
  };
  assert.equal(resolveRecoveryPolicy('scalar', 'default', registry).budget_ms, null);
  assert.equal(resolveRecoveryPolicy('phased', 'scope', registry).budget_ms, null);
  for (const phase of ['scope', '', undefined, null]) {
    assert.throws(() => resolveRecoveryPolicy('scalar', phase, registry), /Unknown phase/);
  }
  for (const phase of ['default', 'other', 'toString', undefined]) {
    assert.throws(() => resolveRecoveryPolicy('phased', phase, registry), /Unknown phase/);
  }
});

for (const value of [undefined, 0, -1, 1.5, NaN, Infinity, '1102000', false, true, {}, [], 1102000n]) {
  test(`invalid scalar and phased recovery budgets throw: ${String(value)}`, () => {
    const registry = {
      scalar: { role: 'scout', budget: 1, recoveryBudgetMs: value },
      phased: { role: 'advisor', budget: { advise: 1 }, recoveryBudgetMs: { advise: value } },
    };
    assert.throws(() => resolveRecoveryPolicy('scalar', 'default', registry), /Invalid recovery budget/);
    assert.throws(() => resolveRecoveryPolicy('phased', 'advise', registry), /Invalid recovery budget/);
  });
}

test('missing recovery budgets throw instead of inheriting a different phase or role', () => {
  const registry = {
    probe: { role: 'advisor', budget: { scope: 1, advise: 1 }, recoveryBudgetMs: { advise: 1102000 } },
    scalar: { role: 'scout', budget: 1 },
  };
  assert.throws(() => resolveRecoveryPolicy('probe', 'scope', registry), /Invalid recovery budget/);
  assert.throws(() => resolveRecoveryPolicy('scalar', 'default', registry), /Invalid recovery budget/);
  registry.probe.recoveryBudgetMs = null;
  assert.throws(() => resolveRecoveryPolicy('probe', 'advise', registry), /Invalid recovery budget/);
});

test('a numeric budget without a catalog record throws for scalar and phased roles', () => {
  const registry = {
    scalar: { role: 'scout', budget: 1, recoveryBudgetMs: 1102000 },
    phased: { role: 'advisor', budget: { scope: 1 }, recoveryBudgetMs: { scope: 1102000 } },
  };
  assert.throws(() => resolveRecoveryPolicy('scalar', 'default', registry), /Missing recovery calibration/);
  assert.throws(() => resolveRecoveryPolicy('phased', 'scope', registry), /Missing recovery calibration/);
});

test('a catalog record with a null registry budget throws', () => {
  const registry = { probe: { role: 'advisor', budget: { advise: 1 }, recoveryBudgetMs: { advise: null } } };
  assert.throws(() => resolveRecoveryPolicy('probe', 'advise', registry), /Recovery calibration.*requires a budget/);
});

test('a registry budget differing from its evidence names both numbers and the joint change rule', () => {
  const registry = { probe: { ...AGENTS['codex-advisor'], recoveryBudgetMs: { scope: null, advise: 1100000 } } };
  assert.throws(() => resolveRecoveryPolicy('probe', 'advise', registry), (error) => {
    assert.match(error.message, /1100000/);
    assert.match(error.message, /1102000/);
    assert.match(error.message, /the number and its evidence change together/);
    return true;
  });
});

test('an enabled switch requires a non-null recovery budget', () => {
  const registry = { probe: { role: 'scout', budget: 1, recoveryBudgetMs: null, silenceThresholdMs: null } };
  assert.throws(() => resolveRecoveryPolicy('probe', 'default', registry, {
    automaticRecoveryEnabled: { 'scout.default': true },
  }), /Automatic recovery.*requires a recovery budget/);
});

test('an enabled switch requires a non-null resolved silence threshold', () => {
  const registry = { probe: { role: 'scout', budget: 1, recoveryBudgetMs: 1102000, silenceThresholdMs: null } };
  assert.throws(() => resolveRecoveryPolicy('probe', 'default', registry, {
    calibrations: { 'scout.default': calibration },
    automaticRecoveryEnabled: { 'scout.default': true },
  }), /Automatic recovery.*requires a silence threshold/);
});

test('a non-boolean switch value throws instead of being recorded as the run switch', () => {
  const registry = { probe: AGENTS['codex-advisor'] };
  for (const value of ['yes', 1, null]) {
    assert.throws(() => resolveRecoveryPolicy('probe', 'advise', registry, {
      automaticRecoveryEnabled: { 'advisor.advise': value },
    }), /Automatic recovery switch for advisor\.advise: expected true or false/);
  }
});

test('enabling advisor recovery also preserves the silence policy calibration guards', () => {
  const registry = {
    probe: { ...AGENTS['codex-advisor'], silenceThresholdMs: { scope: null, advise: null } },
  };
  assert.throws(() => resolveRecoveryPolicy('probe', 'advise', registry, {
    automaticRecoveryEnabled: { 'advisor.advise': true },
  }), /Silence calibration.*requires a threshold/);
});

test('a separately injected enable decision succeeds only with both calibrated prerequisites', () => {
  const registry = { probe: AGENTS['codex-advisor'] };
  const policy = resolveRecoveryPolicy('probe', 'advise', registry, {
    automaticRecoveryEnabled: { 'advisor.advise': true },
  });
  assert.deepEqual(policy, {
    version: 1, role: 'advisor', phase: 'advise', budget_ms: 1102000, enabled: true, calibration,
  });
  assert.equal(AUTOMATIC_RECOVERY_ENABLED['advisor.advise'], false);
  assert.equal(resolveRecoveryPolicy('codex-advisor', 'advise').enabled, false);
});

test('inherited catalog and switch keys do not configure a recovery policy', () => {
  const registry = { probe: { role: 'scout', budget: 1, recoveryBudgetMs: null } };
  const policy = resolveRecoveryPolicy('probe', 'default', registry, {
    calibrations: Object.create({ 'scout.default': calibration }),
    automaticRecoveryEnabled: Object.create({ 'scout.default': true }),
  });
  assert.equal(policy.calibration, null);
  assert.equal(policy.enabled, false);
});

test('collect copies the saved recovery policy verbatim without changing assessments or replies', async () => {
  await withTempTree('recovery-collect-', (dir) => {
    const workerPath = path.join(dir, 'worker.json');
    const original = collect(dir, 'codex-advisor', 1);
    // Plan_80 E15/O2b: historical budgets, switches and host brakes must survive recollection.
    const savedPolicy = {
      ...resolveRecoveryPolicy('codex-advisor', 'advise'),
      budget_ms: 1200000,
      enabled: true,
      calibration: { ...calibration, id: 'historical-recovery-calibration' },
      brake: { key: 'CODEX_BRIDGE_AUTO_RECOVERY', value: 'off', source: 'env' },
    };
    fs.writeFileSync(workerPath, JSON.stringify({ phase: 'advise', recovery_policy: savedPolicy }));
    for (let pass = 0; pass < 2; pass += 1) {
      const { meta, reply } = collect(dir, 'codex-advisor', 1);
      const worker = JSON.parse(fs.readFileSync(workerPath, 'utf8'));
      const recorded = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      assert.deepEqual(meta.recovery_policy, worker.recovery_policy);
      assert.deepEqual(recorded.recovery_policy, savedPolicy);
      const fields = Object.keys(recorded);
      assert.equal(fields[fields.indexOf('silence_policy') + 1], 'recovery_policy');
      for (const field of ['status', 'reason', 'situation', 'continuation_eligibility', 'treatment']) {
        assert.deepEqual(meta[field], original.meta[field], field);
      }
      assert.equal(reply, original.reply);
    }
  });
});

test('collect preserves a recovery policy with no measured budget and a disabled package switch', async () => {
  await withTempTree('recovery-uncalibrated-', (dir) => {
    const savedPolicy = {
      version: 1, role: 'scout', phase: 'default', budget_ms: null, enabled: false,
      calibration: null,
      brake: { key: 'CODEX_BRIDGE_AUTO_RECOVERY', value: 'on', source: 'default' },
    };
    fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({ recovery_policy: savedPolicy }));
    const { meta } = collect(dir, 'codex-scout', 1);
    const recorded = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    assert.deepEqual(meta.recovery_policy, savedPolicy);
    assert.deepEqual(recorded.recovery_policy, savedPolicy);
  });
});

test('collect records a null recovery policy for older runs with no worker or no policy field', async () => {
  await withTempTree('recovery-legacy-', (dir) => {
    for (const worker of [undefined, {}, { recovery_policy: null }]) {
      if (worker !== undefined) fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify(worker));
      const { meta } = collect(dir, 'codex-scout', 1);
      assert.equal(meta.recovery_policy, null);
      const recorded = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      assert.equal(recorded.recovery_policy, null);
    }
  });
});
