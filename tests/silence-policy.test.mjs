/**
 * Plan_80 S2/E12: preserve calibration evidence and the policy ordered for each run.
 * These guards prevent a round-number edit or a later registry update rewriting history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS } from '../src/home/lib/agents.mjs';
import { CALIBRATIONS, resolveSilencePolicy } from '../src/home/lib/silence-policy.mjs';
import { workerOrder, writeWorkerOrder } from '../src/home/lib/runner/worker-order.mjs';
import { collect } from '../src/home/lib/write-meta.mjs';
import { withTempTree } from './temp-tree.mjs';

const phasesOf = (entry) => typeof entry.budget === 'object' ? Object.keys(entry.budget) : ['default'];

for (const [agent, entry] of Object.entries(AGENTS)) {
  for (const phase of phasesOf(entry)) {
    test(`${agent}.${phase} resolves its explicit silence policy`, () => {
      const calibrated = entry.role === 'advisor' && phase === 'advise';
      assert.deepEqual(resolveSilencePolicy(agent, phase), {
        version: 1,
        role: entry.role,
        phase,
        threshold_ms: calibrated ? 996000 : null,
        calibration: calibrated ? CALIBRATIONS['advisor.advise'] : null,
      });
    });
  }
}

test('the frozen catalog retains the complete Plan_80 S2 evidence', () => {
  assert.ok(Object.isFrozen(CALIBRATIONS));
  assert.deepEqual(CALIBRATIONS, {
    'advisor.advise': {
      id: 'plan80-s2-2026-10-13',
      measured_on: '2026-10-13',
      codex_version: '0.160.1',
      sample_runs: 308,
      max_healthy_pause_ms: 855163,
      min_stalled_silence_ms: 1136878,
      rule: 'midpoint of the healthy maximum and the stalled minimum',
    },
  });
  for (const calibration of Object.values(CALIBRATIONS)) {
    assert.ok(Object.isFrozen(calibration));
  }
});

test('every calibration strictly brackets its registry threshold with measured bounds', () => {
  for (const [key, calibration] of Object.entries(CALIBRATIONS)) {
    const [role, phase] = key.split('.');
    const agent = Object.keys(AGENTS).find((name) => AGENTS[name].role === role);
    assert.ok(agent, `Calibration ${key} must name a registered role`);
    const { threshold_ms: threshold } = resolveSilencePolicy(agent, phase);
    assert.equal(typeof threshold, 'number');
    assert.ok(calibration.max_healthy_pause_ms < threshold, `${key}: threshold must exceed healthy pauses`);
    assert.ok(threshold < calibration.min_stalled_silence_ms, `${key}: threshold must precede stalled silence`);
  }
});

test('registry thresholds and catalog records cover one another in both directions', () => {
  const calibratedKeys = [];
  for (const [agent, entry] of Object.entries(AGENTS)) {
    for (const phase of phasesOf(entry)) {
      const value = typeof entry.budget === 'object' ? entry.silenceThresholdMs[phase] : entry.silenceThresholdMs;
      const key = `${entry.role}.${phase}`;
      assert.equal(Object.hasOwn(CALIBRATIONS, key), value !== null, key);
      if (value !== null) calibratedKeys.push(key);
      assert.equal(resolveSilencePolicy(agent, phase).calibration, CALIBRATIONS[key] ?? null);
    }
  }
  assert.deepEqual(calibratedKeys.sort(), Object.keys(CALIBRATIONS).sort());
});

test('unknown agents, including inherited names, throw with an injected registry', () => {
  const registry = { probe: { role: 'scout', budget: 1, silenceThresholdMs: null } };
  assert.throws(() => resolveSilencePolicy('missing', 'default', registry), /Unknown agent/);
  assert.throws(() => resolveSilencePolicy('toString', 'default', registry), /Unknown agent/);
});

test('only budget-declared phases are accepted, including default for scalar budgets', () => {
  const registry = {
    scalar: { role: 'scout', budget: 1, silenceThresholdMs: null },
    phased: { role: 'scout', budget: { scope: 1 }, silenceThresholdMs: { scope: null, other: null } },
  };
  assert.equal(resolveSilencePolicy('scalar', 'default', registry).threshold_ms, null);
  assert.equal(resolveSilencePolicy('phased', 'scope', registry).threshold_ms, null);
  for (const phase of ['scope', '', undefined, null]) {
    assert.throws(() => resolveSilencePolicy('scalar', phase, registry), /Unknown phase/);
  }
  for (const phase of ['default', 'other', 'toString', undefined]) {
    assert.throws(() => resolveSilencePolicy('phased', phase, registry), /Unknown phase/);
  }
});

for (const value of [undefined, 0, -1, 1.5, NaN, Infinity, '996000', false, {}, []]) {
  test(`invalid scalar and phased thresholds throw: ${String(value)}`, () => {
    const registry = {
      scalar: { role: 'scout', budget: 1, silenceThresholdMs: value },
      phased: { role: 'advisor', budget: { advise: 1 }, silenceThresholdMs: { advise: value } },
    };
    assert.throws(() => resolveSilencePolicy('scalar', 'default', registry), /Invalid silence threshold/);
    assert.throws(() => resolveSilencePolicy('phased', 'advise', registry), /Invalid silence threshold/);
  });
}

test('missing phase thresholds throw instead of inheriting a different phase or role', () => {
  const registry = {
    probe: { role: 'advisor', budget: { scope: 1, advise: 1 }, silenceThresholdMs: { advise: 996000 } },
  };
  assert.throws(() => resolveSilencePolicy('probe', 'scope', registry), /Invalid silence threshold/);
  registry.probe.silenceThresholdMs = null;
  assert.throws(() => resolveSilencePolicy('probe', 'advise', registry), /Invalid silence threshold/);
});

test('a numeric threshold without a catalog record throws', () => {
  const registry = { probe: { role: 'scout', budget: 1, silenceThresholdMs: 996000 } };
  assert.throws(() => resolveSilencePolicy('probe', 'default', registry), /Missing silence calibration/);
  registry.probe = { role: 'advisor', budget: { scope: 1 }, silenceThresholdMs: { scope: 996000 } };
  assert.throws(() => resolveSilencePolicy('probe', 'scope', registry), /Missing silence calibration/);
});

test('a catalog record without a numeric registry threshold throws', () => {
  const registry = { probe: { role: 'advisor', budget: { advise: 1 }, silenceThresholdMs: { advise: null } } };
  assert.throws(() => resolveSilencePolicy('probe', 'advise', registry), /requires a threshold/);
});

test('workerOrder and worker.json preserve the supplied silence policy unchanged', async () => {
  await withTempTree('silence-worker-', (dir) => {
    const silencePolicy = resolveSilencePolicy('codex-advisor', 'advise');
    const fields = { agent: 'codex-advisor', phase: 'advise', silencePolicy };
    assert.equal(workerOrder(fields).silence_policy, silencePolicy);
    writeWorkerOrder(dir, fields);
    const worker = JSON.parse(fs.readFileSync(path.join(dir, 'worker.json'), 'utf8'));
    assert.deepEqual(worker.silence_policy, silencePolicy);
  });
});

test('collect copies the saved policy verbatim without registry recomputation or reply changes', async () => {
  await withTempTree('silence-collect-', (dir) => {
    const workerPath = path.join(dir, 'worker.json');
    const original = collect(dir, 'codex-advisor', 1);
    // A historical policy deliberately differs from today's default and catalog id.
    const savedPolicy = {
      ...resolveSilencePolicy('codex-advisor', 'advise'),
      threshold_ms: 1000000,
      calibration: { ...CALIBRATIONS['advisor.advise'], id: 'historical-calibration' },
    };
    fs.writeFileSync(workerPath, JSON.stringify({ phase: 'advise', silence_policy: savedPolicy }));
    for (let pass = 0; pass < 2; pass += 1) {
      const { meta, reply } = collect(dir, 'codex-advisor', 1);
      const worker = JSON.parse(fs.readFileSync(workerPath, 'utf8'));
      const recorded = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      assert.deepEqual(meta.silence_policy, worker.silence_policy);
      assert.deepEqual(recorded.silence_policy, savedPolicy);
      assert.equal(meta.status, original.meta.status);
      assert.equal(meta.reason, original.meta.reason);
      // The assessment rows report the frozen policy (Plan_80 B1c4); the verdict rows are unchanged.
      const verdictRows = (text) => text.split('\n')
        .filter((row) => !/^(Situation|Continuation|Treatment): /.test(row));
      assert.deepEqual(verdictRows(reply), verdictRows(original.reply));
      assert.doesNotMatch(reply, /threshold-unconfigured/);
      assert.match(reply, /^Situation: .* · threshold=1000000 ms · /m);
    }
  });
});

test('collect records a null policy for older runs with no worker or no policy field', async () => {
  await withTempTree('silence-legacy-', (dir) => {
    for (const worker of [undefined, {}, { silence_policy: null }]) {
      if (worker !== undefined) fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify(worker));
      const { meta } = collect(dir, 'codex-scout', 1);
      assert.equal(meta.silence_policy, null);
      const recorded = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      assert.equal(recorded.silence_policy, null);
    }
  });
});
