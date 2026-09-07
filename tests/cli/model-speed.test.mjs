/** Plan_56 step 4: catalogue identifiers, paid confirmation and preservation of existing pins. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { model } from '../../cli/model.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const roles = ['scout', 'build', 'review'];
const credits = 'https://learn.chatgpt.com/docs/agent-configuration/speed';
const tier = () => ({ id: randomUUID(), name: 'Fast', description: '2x speed, increased usage' });
const entry = (overrides = {}) => ({
  slug: randomUUID(), supported_reasoning_levels: [{ effort: 'high' }], visibility: 'list',
  service_tiers: [tier(), tier()], additional_speed_tiers: ['fast'], ...overrides,
});
const catalogue = (...models) => () => JSON.stringify({ models });
const saved = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const noFetch = () => assert.fail('this call must not fetch a catalogue');

function fixture(t, models) {
  const root = makeTempTree('model-speed-');
  t.after(() => removeTempTree(root));
  const configPath = path.join(root, 'config.json');
  const source = JSON.stringify({ models }, null, 2) + '\n';
  fs.writeFileSync(configPath, source);
  return { root, configPath, source };
}

function unchanged({ root, configPath, source }) {
  assert.equal(fs.readFileSync(configPath, 'utf8'), source);
  assert.deepEqual(fs.readdirSync(root), ['config.json']);
}

test('speed refuses missing and unknown roles with all three allowed roles before fetching', async (t) => {
  const data = fixture(t, {});
  for (const args of [[], ['unknown-role'], ['unknown-role', 'unset']]) {
    const result = await model(['speed', ...args], { ...data, fetchCatalogue: noFetch });
    assert.equal(result.exitCode, 2);
    assert.match(result.output, /^codex-bridge model: (role is required|unknown role)/);
    assert.ok(result.output.includes(`Allowed roles: ${roles.join(', ')}.`));
    unchanged(data);
  }
});

test('speed requires a single tier word and accepts only the explicit confirm suffix', async (t) => {
  const data = fixture(t, {});
  const cases = [[], [''], [' '], ['two words'], ['line\nbreak'], ['tab\tword'],
    ['tier', 'yes'], ['tier', 'confirm', 'extra'], ['unset', 'confirm'], ['unset', 'extra']];
  for (const args of cases) {
    const result = await model(['speed', 'build', ...args], { ...data, fetchCatalogue: noFetch });
    assert.equal(result.exitCode, 2, JSON.stringify(args));
    assert.match(result.output, /single word|unexpected argument/);
    unchanged(data);
  }
});

test('a model must be pinned first, including for a missing config, without network or writes', async (t) => {
  for (const profile of [undefined, {}, { effort: 'high' }, { speed: randomUUID() }]) {
    const data = fixture(t, profile ? { build: profile } : {});
    for (const suffix of [[], ['confirm']]) {
      const result = await model(['speed', 'build', randomUUID(), ...suffix], { ...data, fetchCatalogue: noFetch });
      assert.equal(result.exitCode, 2);
      assert.match(result.output, /run model set build <model> first/);
      unchanged(data);
    }
  }
  const { root } = fixture(t, {});
  const configPath = path.join(root, 'absent', 'config.json');
  const result = await model(['speed', 'build', randomUUID(), 'confirm'], { configPath, fetchCatalogue: noFetch });
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /run model set/);
  assert.equal(fs.existsSync(path.dirname(configPath)), false);
});

test('every offered tier previews verbatim cost text and a separate credit link without writing', async (t) => {
  const available = entry();
  available.service_tiers[1].description = '  Usage "notice":\nconsult your allowance.  ';
  for (const role of roles) {
    const data = fixture(t, { [role]: { model: available.slug, effort: 'high' } });
    for (const offered of available.service_tiers) {
      const result = await model(['speed', role, offered.id], { ...data, fetchCatalogue: catalogue(available) });
      assert.equal(result.exitCode, 0, result.output);
      assert.ok(result.output.includes(`Preview — ${role}: ${available.slug} at high effort -> ${available.slug} at high effort on ${offered.id} tier`));
      assert.ok(result.output.includes(`Catalogue description: "${offered.description}"\nCredit multipliers: ${credits}\n`));
      assert.ok(result.output.includes(`second call ending in confirm to apply: codex-bridge model speed ${role} ${offered.id} confirm`));
      assert.match(result.output, /Nothing written\./);
      unchanged(data);
    }
  }
});

test('confirmation pins exactly the chosen tier for every role and reports before, after and machine scope', async (t) => {
  const available = entry();
  for (const role of roles) {
    const profiles = Object.fromEntries(roles.map((key) => [key, { model: available.slug, effort: 'high' }]));
    const data = fixture(t, profiles);
    for (const offered of available.service_tiers) {
      const previous = saved(data.configPath).models[role];
      const result = await model(['speed', role, offered.id, 'confirm'], { ...data, fetchCatalogue: catalogue(available) });
      assert.equal(result.exitCode, 0, result.output);
      assert.deepEqual(saved(data.configPath), { models: { ...profiles, [role]: { ...profiles[role], speed: offered.id } } });
      const before = `${available.slug} at high effort${previous.speed ? ` on ${previous.speed} tier` : ''}`;
      assert.ok(result.output.includes(`${role}: ${before} -> ${available.slug} at high effort on ${offered.id} tier`));
      assert.ok(result.output.includes(`Config file: ${data.configPath}`));
      assert.match(result.output, /Machine-wide: shared by every project on this machine, not per-project\./);
    }
  }
});

test('speed edits retain raw profile fields, other roles and unrelated configuration without defaults', async (t) => {
  const available = entry();
  const profiles = { build: { model: ` ${available.slug} `, effort: ' high ' }, scout: {}, review: { effort: ' future ' } };
  const data = fixture(t, profiles);
  const retention = '"retention": {"enabled": false, "days": "leave untouched"}';
  fs.writeFileSync(data.configPath, data.source.replace('{', `{\n  ${retention},`));
  const speed = available.service_tiers[0].id;
  const result = await model(['speed', 'build', speed, 'confirm'], { ...data, fetchCatalogue: catalogue(available) });
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(saved(data.configPath).models, { ...profiles, build: { ...profiles.build, speed } });
  assert.ok(fs.readFileSync(data.configPath, 'utf8').includes(retention));
  assert.deepEqual(Object.keys(saved(data.configPath)), ['retention', 'models']);
});

test('unset removes only speed for every role without fetching or confirmation', async (t) => {
  for (const role of roles) {
    const profiles = Object.fromEntries(roles.map((key) => [key, { model: randomUUID(), effort: ' high ', speed: randomUUID() }]));
    const data = fixture(t, profiles);
    const before = profiles[role];
    const result = await model(['speed', role, 'unset'], { ...data, fetchCatalogue: noFetch });
    assert.equal(result.exitCode, 0, result.output);
    assert.ok(result.output.includes(`on ${before.speed} tier -> ${before.model} at ${before.effort} effort`));
    assert.match(result.output, /Machine-wide/);
    assert.deepEqual(saved(data.configPath).models, { ...profiles, [role]: { model: before.model, effort: before.effort } });
  }
  for (const profile of [undefined, {}, { speed: randomUUID() }]) {
    const data = fixture(t, profile ? { build: profile } : {});
    assert.equal((await model(['speed', 'build', 'unset'], { ...data, fetchCatalogue: noFetch })).exitCode, 0);
    assert.deepEqual(saved(data.configPath).models, profile ? { build: {} } : {});
  }
});

test('tiers belong to that model: labels, other models and unknown identifiers are refused', async (t) => {
  const available = entry();
  const other = entry();
  const data = fixture(t, { build: { model: available.slug } });
  for (const speed of ['fast', other.service_tiers[0].id, randomUUID()]) {
    for (const suffix of [[], ['confirm']]) {
      const result = await model(['speed', 'build', speed, ...suffix], { ...data, fetchCatalogue: catalogue(available, other) });
      assert.equal(result.exitCode, 2);
      assert.ok(result.output.includes(`speed "${speed}" is not supported by model "${available.slug}"`));
      assert.ok(result.output.includes(`Accelerated tiers: ${available.service_tiers.map(({ id }) => id).join(', ')}`));
      unchanged(data);
    }
  }
});

test('empty or absent service tiers offer no acceleration even when a parallel label exists', async (t) => {
  for (const service_tiers of [[], undefined]) {
    const available = entry({ service_tiers });
    const data = fixture(t, { build: { model: available.slug } });
    const result = await model(['speed', 'build', 'fast', 'confirm'], { ...data, fetchCatalogue: catalogue(available) });
    assert.equal(result.exitCode, 2);
    assert.ok(result.output.includes(`model "${available.slug}" has no accelerated tier`));
    unchanged(data);
  }
});

test('a pinned model missing from the live catalogue is refused without an invented entry', async (t) => {
  const data = fixture(t, { build: { model: randomUUID() } });
  for (const entries of [[], [entry()]]) {
    const result = await model(['speed', 'build', randomUUID(), 'confirm'], { ...data, fetchCatalogue: catalogue(...entries) });
    assert.equal(result.exitCode, 2);
    assert.match(result.output, /unknown model.*Available models/);
    unchanged(data);
  }
});

test('confirmation fetches fresh and refuses catalogue failures with their cause and no cache', async (t) => {
  const available = entry();
  const data = fixture(t, { build: { model: available.slug } });
  const args = ['speed', 'build', available.service_tiers[0].id];
  let calls = 0;
  const fetchCatalogue = () => {
    calls += 1;
    if (calls > 1) throw new Error('authentication expired');
    return catalogue(available)();
  };
  assert.equal((await model(args, { ...data, fetchCatalogue })).exitCode, 0);
  const result = await model([...args, 'confirm'], { ...data, fetchCatalogue });
  assert.equal(calls, 2);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /live catalogue unavailable; refusing to set build speed: authentication expired/);
  for (const payload of ['{broken', '{}', catalogue(entry({ service_tiers: [null] }))(),
    catalogue(entry({ service_tiers: [{ id: randomUUID() }] }))()]) {
    const failed = await model([...args, 'confirm'], { ...data, fetchCatalogue: () => payload });
    assert.equal(failed.exitCode, 1);
    assert.match(failed.output, /live catalogue unavailable/);
  }
  unchanged(data);
});

test('a tier removed between preview and confirmation cannot be pinned', async (t) => {
  const available = entry();
  const data = fixture(t, { build: { model: available.slug } });
  const args = ['speed', 'build', available.service_tiers[0].id];
  assert.equal((await model(args, { ...data, fetchCatalogue: catalogue(available) })).exitCode, 0);
  const result = await model([...args, 'confirm'], { ...data,
    fetchCatalogue: catalogue({ ...available, service_tiers: available.service_tiers.slice(1) }) });
  assert.equal(result.exitCode, 2);
  assert.ok(result.output.includes(available.service_tiers[1].id));
  unchanged(data);
});

test('model set refuses incompatible retained speed beside effort validation and preserves compatible pins', async (t) => {
  const old = entry();
  const speed = old.service_tiers[0].id;
  const profiles = { build: { model: old.slug, effort: 'high', speed } };
  const data = fixture(t, profiles);
  for (const available of [entry(), entry({ service_tiers: [] })]) {
    const result = await model(['set', 'build', available.slug], { ...data, fetchCatalogue: catalogue(available) });
    assert.equal(result.exitCode, 2);
    assert.ok(result.output.includes(`existing speed "${speed}" is not supported by model "${available.slug}"`));
    // Asserted per case rather than through a fallback: an `||` here passes on either sentence and
    // would not notice the two answers being swapped, which is the only thing worth checking.
    assert.ok(available.service_tiers.length
      ? result.output.includes(`Accelerated tiers it does offer: ${available.service_tiers.map(({ id }) => id).join(', ')}.`)
      : result.output.includes('That model offers no accelerated tier at all.'));
    assert.match(result.output, /model speed build unset/);
    unchanged(data);
  }
  const compatible = entry({ service_tiers: old.service_tiers });
  const result = await model(['set', 'build', compatible.slug], { ...data, fetchCatalogue: catalogue(compatible) });
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(saved(data.configPath).models, { build: { ...profiles.build, model: compatible.slug } });
  assert.ok(result.output.includes(`on ${speed} tier -> ${compatible.slug} at high effort on ${speed} tier`));
});

test('speed validates and preserves the current profile after waiting for the catalogue', async (t) => {
  const initial = entry();
  const current = entry();
  const speed = current.service_tiers[1].id;
  const data = fixture(t, { build: { model: initial.slug } });
  const profiles = { build: { model: current.slug, effort: 'high' }, scout: { model: randomUUID() } };
  const fetchCatalogue = async () => {
    fs.writeFileSync(data.configPath, JSON.stringify({ models: profiles }));
    return catalogue(initial, current)();
  };
  const result = await model(['speed', 'build', speed, 'confirm'], { ...data, fetchCatalogue });
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(saved(data.configPath).models, { ...profiles, build: { ...profiles.build, speed } });
  for (const changed of [{ build: { model: initial.slug } }, {}]) {
    const failed = await model(['speed', 'build', speed, 'confirm'], { ...data, fetchCatalogue: async () => {
      fs.writeFileSync(data.configPath, JSON.stringify({ models: changed }));
      return catalogue(initial, current)();
    } });
    assert.equal(failed.exitCode, 2);
    assert.match(failed.output, /not supported|run model set/);
    assert.deepEqual(saved(data.configPath).models, changed);
  }
});

test('invalid configs and shared-writer failures are reported and leave no partial speed edit', async (t) => {
  const available = entry();
  const data = fixture(t, { build: { model: available.slug } });
  // Publishing became synchronous with D44: an await between comparison and rename let a
  // sibling edit slip in, proven by a live probe of three concurrent processes.
  t.mock.method(fs, 'renameSync', () => { throw new Error('rename refused'); });
  const args = ['speed', 'build', available.service_tiers[0].id, 'confirm'];
  const result = await model(args, { ...data, fetchCatalogue: catalogue(available) });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /cannot set speed: rename refused/);
  unchanged(data);
  fs.writeFileSync(data.configPath, '{broken');
  const failed = await model(args, { ...data, fetchCatalogue: noFetch });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.output, /cannot set speed.*cannot parse/);
  assert.equal(fs.readFileSync(data.configPath, 'utf8'), '{broken');
});

test('speed writes only through the shared editor and runtime tier spellings come from metadata', () => {
  const source = fs.readFileSync(new URL('../../cli/model-speed.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ editRunConfig \} from/);
  assert.match(source, /await editRunConfig\('models', transform, configPath\)/);
  assert.doesNotMatch(source, /\b(?:writeFile(?:Sync)?|rename(?:Sync)?|copyFile(?:Sync)?)\s*\(/);
  for (const file of ['model-speed.mjs', 'model-set.mjs', 'model-catalogue.mjs']) {
    const code = fs.readFileSync(new URL(`../../cli/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /['"](?:fast|priority|ultrafast|zzz_bogus|standard|default)['"]/);
  }
});

test('speed unset answers on a config file that does not exist yet', async (t) => {
  // The transformer sees an absent key there, and validating it as a malformed one turned this
  // answer into the validator's refusal — the same slip the missing-config case in model.test.mjs
  // caught for set. Both commands read the absent key, so both are covered.
  const root = makeTempTree('model-speed-missing-');
  t.after(() => removeTempTree(root));
  const configPath = path.join(root, 'absent', 'config.json');
  const result = await model(['speed', 'build', 'unset'], { configPath, fetchCatalogue: noFetch });
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /build: not set \(Codex chooses\) -> not set \(Codex chooses\)/);
  assert.deepEqual(saved(configPath), { models: {} });
});
