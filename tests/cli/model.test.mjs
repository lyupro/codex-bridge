/** Verifies profile reads, catalogue-checked edits and dispatcher contracts (Plan_56). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { model } from '../../cli/model.mjs';
import { validateRunConfig } from '../../src/home/lib/config-validate.mjs';
import { HELP, main } from '../../bin/codex-bridge.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const roles = ['scout', 'build', 'review', 'advisor'];

function fixture(t, models) {
  const root = makeTempTree('model-profile-');
  t.after(() => removeTempTree(root));
  const configPath = path.join(root, 'config.json');
  const source = `${JSON.stringify({ models }, null, 2)}\n`;
  fs.writeFileSync(configPath, source);
  return { root, configPath, source };
}

function configuredProfiles() {
  return Object.fromEntries(roles.map((role, index) => [role, {
    model: randomUUID(), effort: ['low', 'max', 'high', 'medium'][index],
  }]));
}

function profileRows(output) {
  const [table] = output.split('\n\n');
  assert.match(table, /^role\s+model\s+effort\s+speed\s+source\n/);
  const rows = table.split('\n').slice(1);
  assert.equal(rows.length, roles.length);
  return rows;
}

test('model shows every configured role as a table without writing or printing', async (t) => {
  const profiles = configuredProfiles();
  profiles.scout.speed = randomUUID();
  const { root, configPath, source } = fixture(t, profiles);
  const log = t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const result = await model([], {
    configPath,
    codexHome: root,
    terminalWidth: 40,
    fetchCatalogue: () => assert.fail('showing profiles must not contact Codex'),
  });

  assert.equal(result.exitCode, 0);
  const rows = profileRows(result.output);
  roles.forEach((role, index) => {
    const speedSource = profiles[role].speed ? 'config file' : 'not pinned';
    const ignored = role === 'build' ? '' : ' (operator Codex config not read)';
    assert.equal(rows[index].trim().replace(/\s+/g, ' '),
      `${role} ${profiles[role].model} ${profiles[role].effort} ${profiles[role].speed || 'not pinned'} config file; speed: ${speedSource}${ignored}`);
  });
  assert.ok(result.output.includes(`Config file: ${path.resolve(configPath)}`));
  assert.match(result.output, /Machine-wide: shared by every project on this machine, not per-project\./);
  assert.equal(fs.readFileSync(configPath, 'utf8'), source);
  assert.equal(log.mock.callCount(), 0);
  assert.equal(error.mock.callCount(), 0);
});

test('an unset role shows the runner default with honest default provenance', async (t) => {
  const profiles = configuredProfiles();
  delete profiles.review;
  const { root, configPath } = fixture(t, profiles);
  const result = await model([], { configPath, codexHome: root });

  assert.equal(result.exitCode, 0);
  const rows = profileRows(result.output);
  assert.match(rows[2], /^review\s+Codex default \(not pinned\)\s+medium\s+not pinned\s+model: not set \(Codex chooses\); effort: package default; speed: not pinned \(operator Codex config not read\)$/);
  assert.match(rows[0], /config file; speed: not pinned \(operator Codex config not read\)$/);
  assert.match(rows[1], /config file; speed: not pinned$/);
});

test('partial profiles report model and effort provenance separately', async (t) => {
  const configuredId = randomUUID();
  const { root, configPath } = fixture(t, {
    scout: { model: configuredId }, build: { effort: 'max' }, review: {},
  });
  const result = await model([], { configPath, codexHome: root });

  assert.equal(result.exitCode, 0);
  const rows = profileRows(result.output);
  assert.ok(rows[0].includes(configuredId));
  assert.match(rows[0], /medium\s+not pinned\s+model: config file; effort: package default; speed: not pinned \(operator Codex config not read\)$/);
  assert.match(rows[1], /Codex default \(not pinned\)\s+max\s+not pinned\s+model: not set \(Codex chooses\); effort: config file; speed: not pinned$/);
  assert.match(rows[2], /medium\s+not pinned\s+model: not set \(Codex chooses\); effort: package default; speed: not pinned \(operator Codex config not read\)$/);
});

test('a missing config is shown as defaults without creating it', async (t) => {
  const { root } = fixture(t, {});
  const configPath = path.join(root, 'absent.json');
  const result = await model([], { configPath: path.relative(process.cwd(), configPath), codexHome: root });

  assert.equal(result.exitCode, 0);
  for (const row of profileRows(result.output)) assert.match(row, /medium\s+not pinned\s+model: not set \(Codex chooses\); effort: package default; speed: not pinned(?: \(operator Codex config not read\))?$/);
  assert.ok(result.output.includes(`Config file: ${configPath}`));
  assert.equal(fs.existsSync(configPath), false);
});

test('each profile display reads the current config through the existing validator', async (t) => {
  const { configPath } = fixture(t, configuredProfiles());
  const first = await model([], { configPath });
  const updated = configuredProfiles();
  fs.writeFileSync(configPath, JSON.stringify({ models: updated }));
  const second = await model([], { configPath });

  assert.equal(second.exitCode, 0);
  assert.notEqual(first.output, second.output);
  assert.ok(second.output.includes(updated.build.model));
  fs.writeFileSync(configPath, '{broken');
  const broken = await model([], { configPath });
  assert.equal(broken.exitCode, 1);
  assert.match(broken.output, /cannot read profile.*cannot be parsed as JSON/);
  assert.ok(broken.output.includes(configPath));
  assert.doesNotMatch(broken.output, /package default/);
});

test('model refuses unsupported actions and arguments before reading or fetching', async (t) => {
  const { configPath, source } = fixture(t, configuredProfiles());
  const cases = [['set'], ['unknown'], ['--json'], ['list', '--bundled'], ['list', 'extra']];
  for (const argv of cases) {
    const result = await model(argv, {
      configPath,
      fetchCatalogue: () => assert.fail('invalid arguments must not fetch a catalogue'),
    });
    assert.equal(result.exitCode, 2, argv.join(' '));
    assert.match(result.output, /unknown action|unexpected argument|role is required/);
  }
  assert.equal(fs.readFileSync(configPath, 'utf8'), source);
});

test('dispatcher shows the configured machine-wide profile from CODEX_BRIDGE_HOME', (t) => {
  const profiles = configuredProfiles();
  const { root, configPath, source } = fixture(t, profiles);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'codex-bridge.mjs'), 'model'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CODEX_BRIDGE_HOME: root },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(profileRows(result.stdout).length, roles.length);
  for (const role of roles) assert.ok(result.stdout.includes(profiles[role].model));
  assert.ok(result.stdout.includes(configPath));
  assert.equal(fs.readFileSync(configPath, 'utf8'), source);
});

test('dispatcher forwards model arguments and returns the command exit code', async () => {
  const messages = [];
  const exitCode = await main(['model', 'list', 'extra'], {
    log: (message) => messages.push(message), error: () => assert.fail('unexpected dispatcher error'),
  });
  assert.equal(exitCode, 2);
  assert.deepEqual(messages, ['codex-bridge model: unexpected argument "extra".']);
  assert.match(HELP, /^  codex-bridge model \[list\]$/m);
  assert.match(HELP, /^  model\s+Show machine-wide model profiles or list the live catalogue$/m);
});

test('speed is a registered action and the dispatcher returns its missing-role refusal', async () => {
  const messages = [];
  const result = await main(['model', 'speed'], { log: (message) => messages.push(message) });
  assert.equal(result, 2);
  assert.deepEqual(messages, [`codex-bridge model: role is required. Allowed roles: ${roles.join(', ')}.`]);
});

test('dispatcher forwards speed unset to the machine-wide profile without removing model or effort', (t) => {
  const profiles = configuredProfiles();
  profiles.build.speed = randomUUID();
  const { root, configPath } = fixture(t, profiles);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'codex-bridge.mjs'), 'model', 'speed', 'build', 'unset'], {
    cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_BRIDGE_HOME: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`on ${profiles.build.speed} tier ->`));
  delete profiles.build.speed;
  assert.deepEqual(savedModels(configPath), profiles);
});

test('Plan_56 additions stay below 400 lines and use role terminology', () => {
  const files = ['cli/model.mjs', 'cli/model-set.mjs', 'cli/model-catalogue.mjs', 'bin/codex-bridge.mjs',
    'cli/model-speed.mjs', 'tests/cli/model-speed.test.mjs', 'tests/cli/model.test.mjs', 'tests/cli/model-catalogue.test.mjs'];
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(source.trimEnd().split('\n').length <= 400, file);
    if (file.startsWith('cli/')) assert.doesNotMatch(source, /\bmode\b/, file);
  }
});

function catalogueEntry(slug, efforts, visibility = 'list') {
  return { slug, supported_reasoning_levels: efforts.map((effort) => ({ effort })), visibility };
}
const catalogue = (...entries) => () => JSON.stringify({ models: entries });
const savedModels = (configPath) => JSON.parse(fs.readFileSync(configPath, 'utf8')).models;

test('set writes exactly one role immediately using positional, option and mixed arguments', async (t) => {
  for (const role of roles) {
    const profiles = configuredProfiles();
    const { configPath } = fixture(t, profiles);
    const modelId = randomUUID();
    const effort = randomUUID();
    const forms = [[modelId, effort], ['--model', modelId, '--effort', effort], [modelId, '--effort', effort]];
    const result = await model(['set', role, ...forms[roles.indexOf(role) % forms.length]], {
      configPath, fetchCatalogue: catalogue(catalogueEntry(modelId, [effort])),
    });
    assert.equal(result.exitCode, 0, result.output);
    assert.deepEqual(savedModels(configPath), { ...profiles, [role]: { model: modelId, effort } });
    const previous = profiles[role];
    assert.ok(
      result.output.includes(`${role}: ${previous.model} at ${previous.effort} effort -> ${modelId} at ${effort} effort`),
      result.output,
    );
    assert.match(result.output, /Machine-wide: shared by every project on this machine, not per-project\./);
  }
});

test('set and unset refuse absent or unknown roles and malformed arguments before fetching', async (t) => {
  const { configPath, source } = fixture(t, configuredProfiles());
  for (const action of ['set', 'unset']) {
    for (const role of [undefined, 'unknown-role']) {
      const result = await model([action, ...(role ? [role] : [])], {
        configPath, fetchCatalogue: () => assert.fail('invalid role must not fetch'),
      });
      assert.equal(result.exitCode, 2);
      assert.match(result.output, /role is required|unknown role/);
      assert.ok(result.output.includes(roles.join(', ')));
    }
  }
  for (const argv of [['set', 'build'], ['set', 'build', '--model'], ['set', 'build', '--effort'],
    ['set', 'build', '--unknown'], ['set', 'build', 'a', 'b', 'extra'],
    ['set', 'build', 'a', '--model', 'b'], ['set', 'build', ''],
    ['set', 'build', 'two words'], ['set', 'build', 'a', 'two words'], ['unset', 'build', 'extra']]) {
    assert.equal((await model(argv, { configPath,
      fetchCatalogue: () => assert.fail('invalid arguments must not fetch') })).exitCode, 2, argv.join(' '));
  }
  assert.equal(fs.readFileSync(configPath, 'utf8'), source);
});

test('unknown models and unsupported explicit or retained efforts refuse without writing', async (t) => {
  const profiles = configuredProfiles();
  const { configPath, source } = fixture(t, profiles);
  const modelId = randomUUID();
  const efforts = [randomUUID(), randomUUID()];
  const other = catalogueEntry(randomUUID(), [profiles.build.effort]);
  const fetchCatalogue = catalogue(catalogueEntry(modelId, efforts), other);
  for (const args of [[randomUUID(), efforts[0]], [modelId, profiles.build.effort], [modelId]]) {
    const result = await model(['set', 'build', ...args], { configPath, fetchCatalogue });
    assert.equal(result.exitCode, 2);
    assert.ok(result.output.includes(modelId));
    if (args[0] !== modelId) {
      assert.match(result.output, /unknown model/);
      assert.ok(result.output.includes(other.slug));
    } else {
      assert.ok(result.output.includes(efforts.join(', ')));
      assert.ok(result.output.includes(profiles.build.effort));
      assert.match(result.output, /not supported/);
      if (args.length === 1) assert.match(result.output, /existing effort/);
    }
    assert.equal(fs.readFileSync(configPath, 'utf8'), source);
  }
});

test('hidden catalogue models are written with an explicit hidden notice', async (t) => {
  for (const visibility of ['hide', 'none']) {
    const { configPath } = fixture(t, configuredProfiles());
    const modelId = randomUUID();
    const effort = randomUUID();
    const result = await model(['set', 'review', modelId, effort], {
      configPath, fetchCatalogue: catalogue(catalogueEntry(modelId, [effort], visibility)),
    });
    assert.equal(result.exitCode, 0, result.output);
    assert.match(result.output, /hidden in the Codex catalogue/);
    assert.deepEqual(savedModels(configPath).review, { model: modelId, effort });
  }
});

test('every set fetches fresh and catalogue failures never reuse a previous success', async (t) => {
  const { configPath } = fixture(t, configuredProfiles());
  const modelId = randomUUID();
  const effort = randomUUID();
  let calls = 0;
  const fetchCatalogue = async () => {
    calls += 1;
    if (calls > 1) throw new Error('authentication expired');
    return catalogue(catalogueEntry(modelId, [effort]))();
  };
  const args = ['set', 'scout', modelId, effort];
  assert.equal((await model(args, { configPath, fetchCatalogue })).exitCode, 0);
  const source = fs.readFileSync(configPath, 'utf8');
  const failed = await model(args, { configPath, fetchCatalogue });
  assert.equal(calls, 2);
  assert.equal(failed.exitCode, 1);
  assert.match(failed.output, /live catalogue unavailable; refusing to set scout: authentication expired/);
  for (const payload of ['{broken', '{}', catalogue(catalogueEntry(modelId, [null]))()]) {
    const result = await model(args, { configPath, fetchCatalogue: () => payload });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /live catalogue unavailable/);
  }
  assert.equal(fs.readFileSync(configPath, 'utf8'), source);
});

test('model-only and effort-only edits preserve unspecified fields and never materialize defaults', async (t) => {
  const profiles = configuredProfiles();
  profiles.review = {};
  profiles.scout.model = `  ${profiles.scout.model}  `;
  profiles.build.effort = ` ${profiles.build.effort} `;
  const { configPath } = fixture(t, profiles);
  const raw = fs.readFileSync(configPath, 'utf8').replace('{', '{\n  "retention": {"enabled": false, "days": "leave untouched"},');
  fs.writeFileSync(configPath, raw);
  const modelId = randomUUID();
  const effort = randomUUID();
  const fetchCatalogue = catalogue(catalogueEntry(modelId, [profiles.build.effort.trim(), effort]));
  assert.equal((await model(['set', 'build', modelId], { configPath, fetchCatalogue })).exitCode, 0);
  assert.deepEqual(savedModels(configPath), { ...profiles, build: { ...profiles.build, model: modelId } });
  assert.equal((await model(['set', 'build', '--effort', effort], { configPath, fetchCatalogue })).exitCode, 0);
  assert.deepEqual(savedModels(configPath), { ...profiles, build: { model: modelId, effort } });
  assert.ok(fs.readFileSync(configPath, 'utf8').includes('"retention": {"enabled": false, "days": "leave untouched"}'));
  assert.equal((await model(['set', 'review', modelId], { configPath, fetchCatalogue })).exitCode, 0);
  assert.deepEqual(savedModels(configPath).review, { model: modelId });
});

test('set creates a missing config only after validation and refuses effort without a model', async (t) => {
  const { root } = fixture(t, {});
  const configPath = path.join(root, 'new', 'config.json');
  const modelId = randomUUID();
  const effort = randomUUID();
  const args = ['set', 'scout', modelId, effort];
  assert.equal((await model(args, { configPath, fetchCatalogue: () => { throw new Error('offline'); } })).exitCode, 1);
  const missing = await model(['set', 'scout', '--effort', effort], {
    configPath, fetchCatalogue: catalogue(catalogueEntry(modelId, [effort])),
  });
  assert.equal(missing.exitCode, 2);
  assert.match(missing.output, /no configured model/);
  assert.equal(fs.existsSync(path.dirname(configPath)), false);
  assert.equal((await model(args, { configPath,
    fetchCatalogue: catalogue(catalogueEntry(modelId, [effort])) })).exitCode, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { models: { scout: { model: modelId, effort } } });
});

test('unset removes exactly the named role without fetching and reports Codex chooses', async (t) => {
  for (const role of roles) {
    const profiles = configuredProfiles();
    const { configPath } = fixture(t, profiles);
    const result = await model(['unset', role], {
      configPath, fetchCatalogue: () => assert.fail('unset must not fetch'),
    });
    assert.equal(result.exitCode, 0, result.output);
    // The profile is stated as the sentence the config module already uses for one, not as a
    // serialized object: two spellings of one idea is the defect this whole plan is about.
    const { model: modelId, effort } = profiles[role];
    assert.ok(result.output.includes(`${role}: ${modelId} at ${effort} effort ->`), result.output);
    assert.match(result.output, /-> not set \(Codex chooses\)/);
    assert.match(result.output, /Machine-wide/);
    delete profiles[role];
    assert.deepEqual(savedModels(configPath), profiles);
  }
});

test('offline config validation accepts future effort words and rejects malformed effort forms', () => {
  for (const effort of ['ultra', 'none', randomUUID()]) {
    const config = { models: { build: { effort } } };
    assert.deepEqual(validateRunConfig('fixture.json', config).models, config.models);
  }
  for (const effort of ['', ' ', 'two words', 'line\nbreak', 1, null]) {
    assert.throws(() => validateRunConfig('fixture.json', { models: { build: { effort } } }),
      /models.build.effort.*(?:empty|single word|string)/);
  }
  assert.equal(validateRunConfig('fixture.json', { models: { build: { effort: ' future-depth ' } } })
    .models.build.effort, 'future-depth', 'existing config trimming remains intact');
});

test('set preserves edits made while the live catalogue request is pending', async (t) => {
  const { configPath } = fixture(t, configuredProfiles());
  const current = configuredProfiles();
  const modelId = randomUUID();
  const fetchCatalogue = async () => {
    fs.writeFileSync(configPath, JSON.stringify({ models: current }));
    return catalogue(catalogueEntry(modelId, [current.build.effort]))();
  };
  const result = await model(['set', 'build', modelId], { configPath, fetchCatalogue });
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(savedModels(configPath), { ...current, build: { ...current.build, model: modelId } });
});
