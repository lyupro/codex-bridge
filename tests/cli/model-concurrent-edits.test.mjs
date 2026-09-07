/**
 * Plan_56 D40/D44: a role edit computed during the catalogue wait must not overwrite a newer one.
 * The command's own behaviour is covered in model-speed.test.mjs; these cases are competition.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { model } from '../../cli/model.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const tier = () => ({ id: randomUUID(), name: 'Fast', description: '2x speed, increased usage' });
const entry = (overrides = {}) => ({
  slug: randomUUID(), supported_reasoning_levels: [{ effort: 'high' }], visibility: 'list',
  service_tiers: [tier(), tier()], additional_speed_tiers: ['fast'], ...overrides,
});
const catalogue = (...models) => () => JSON.stringify({ models });
const saved = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function fixture(t, models) {
  const root = makeTempTree('model-race-');
  t.after(() => removeTempTree(root));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({ models }, null, 2)}
`);
  return { root, configPath };
}

test('model set preserves role edits made while the catalogue was being fetched', async (t) => {
  const available = entry();
  const data = fixture(t, { build: { model: available.slug } });
  const profiles = { build: { model: available.slug, speed: available.service_tiers[0].id }, scout: {} };
  let fetches = 0;
  const result = await model(['set', 'build', '--effort', 'high'], { ...data, fetchCatalogue: async () => {
    fetches += 1;
    fs.writeFileSync(data.configPath, JSON.stringify({ plugins: true, models: profiles }));
    return catalogue(available)();
  } });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(fetches, 1);
  assert.deepEqual(saved(data.configPath), {
    plugins: true, models: { ...profiles, build: { ...profiles.build, effort: 'high' } },
  });
  assert.deepEqual(fs.readdirSync(data.root), ['config.json']);
});

test('model and speed retries preserve concurrent profiles without fetching the catalogue again', async (t) => {
  for (const action of ['set', 'speed', 'unset', 'speed-unset']) {
    await t.test(action, async (t) => {
      const available = entry();
      const speed = available.service_tiers[0].id;
      const data = fixture(t, { build: { model: available.slug, speed } });
      const profiles = { build: { model: available.slug, effort: 'high', speed }, scout: { model: randomUUID() } };
      const open = fsp.open;
      let attempts = 0;
      let fetches = 0;
      t.mock.method(fsp, 'open', async (...args) => {
        // Only the temporary file: the first open is now the lock, taken before the edit reads.
        if (!String(args[0]).endsWith('.tmp')) return open(...args);
        attempts += 1;
        if (attempts === 1) fs.writeFileSync(data.configPath, JSON.stringify({ plugins: true, models: profiles }));
        return open(...args);
      });
      const args = action === 'set' ? ['set', 'build', '--effort', 'high']
        : action === 'speed' ? ['speed', 'build', speed, 'confirm']
          : action === 'unset' ? ['unset', 'build'] : ['speed', 'build', 'unset'];
      const result = await model(args, { ...data, fetchCatalogue: () => {
        fetches += 1;
        assert.ok(action === 'set' || action === 'speed');
        return catalogue(available)();
      } });
      assert.equal(result.exitCode, 0, result.output);
      assert.equal(attempts, 2);
      assert.equal(fetches, action === 'set' || action === 'speed' ? 1 : 0);
      const expected = action === 'unset' ? { scout: profiles.scout }
        : action === 'speed-unset' ? { ...profiles, build: { model: available.slug, effort: 'high' } } : profiles;
      assert.deepEqual(saved(data.configPath), { plugins: true, models: expected });
      assert.ok(result.output.includes(`build: ${available.slug} at high effort on ${speed} tier ->`));
      assert.deepEqual(fs.readdirSync(data.root), ['config.json']);
    });
  }
});

test('a retry refuses a role model changed after catalogue validation through the existing failure catch', async (t) => {
  // D40/D41: even a second model offering the same tier must not inherit the first model's decision.
  for (const action of ['set', 'speed']) {
    await t.test(action, async (t) => {
      const available = entry();
      const other = entry({ service_tiers: available.service_tiers });
      const data = fixture(t, { build: { model: available.slug } });
      const intruder = JSON.stringify({ models: { build: { model: other.slug }, scout: {} } });
      const open = fsp.open;
      let fetches = 0;
      let attempts = 0;
      t.mock.method(fsp, 'open', async (...args) => {
        if (!String(args[0]).endsWith('.tmp')) return open(...args);
        attempts += 1;
        fs.writeFileSync(data.configPath, intruder);
        return open(...args);
      });
      const args = action === 'set' ? ['set', 'build', '--effort', 'high']
        : ['speed', 'build', available.service_tiers[0].id, 'confirm'];
      const result = await model(args, { ...data, fetchCatalogue: () => {
        fetches += 1;
        return catalogue(available, other)();
      } });
      assert.equal(result.exitCode, 1);
      assert.equal(result.output, `codex-bridge model: cannot set ${action === 'set' ? 'profile' : 'speed'}: `
        + 'The profile changed while the catalogue was being read; nothing was written. Run the command again.');
      assert.equal(attempts, 1);
      assert.equal(fetches, 1);
      assert.equal(fs.readFileSync(data.configPath, 'utf8'), intruder);
      assert.deepEqual(fs.readdirSync(data.root), ['config.json']);
    });
  }
});

test('a model retry validates the newly retained effort with the original refusal and exit code', async (t) => {
  const available = entry();
  const data = fixture(t, { build: { model: available.slug, effort: 'high' } });
  const intruder = JSON.stringify({ models: { build: { model: available.slug, effort: 'low' } } });
  const open = fsp.open;
  t.mock.method(fsp, 'open', async (...args) => {
    if (String(args[0]).endsWith('.tmp')) fs.writeFileSync(data.configPath, intruder);
    return open(...args);
  });
  const result = await model(['set', 'build', available.slug], { ...data, fetchCatalogue: catalogue(available) });
  assert.equal(result.exitCode, 2);
  assert.equal(result.output, `codex-bridge model: existing effort "low" is not supported by model "${available.slug}". `
    + 'Supported depths: high. Supply a supported effort explicitly. Nothing written.');
  assert.equal(fs.readFileSync(data.configPath, 'utf8'), intruder);
  assert.deepEqual(fs.readdirSync(data.root), ['config.json']);
});
