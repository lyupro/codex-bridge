/** Verifies the read-only profile command and its dispatcher contract (Plan_56 step 2). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { model } from '../../cli/model.mjs';
import { HELP, main } from '../../bin/codex-bridge.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const roles = ['scout', 'build', 'review'];

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
    model: randomUUID(), effort: ['low', 'max', 'high'][index],
  }]));
}

function profileRows(output) {
  const [table] = output.split('\n\n');
  assert.match(table, /^role\s+model\s+effort\s+source\n/);
  const rows = table.split('\n').slice(1);
  assert.equal(rows.length, 3);
  return rows;
}

test('model shows all three configured roles as a table without writing or printing', async (t) => {
  const profiles = configuredProfiles();
  const { configPath, source } = fixture(t, profiles);
  const log = t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const result = await model([], {
    configPath,
    terminalWidth: 40,
    fetchCatalogue: () => assert.fail('showing profiles must not contact Codex'),
  });

  assert.equal(result.exitCode, 0);
  const rows = profileRows(result.output);
  roles.forEach((role, index) => {
    assert.equal(rows[index].trim().replace(/\s+/g, ' '),
      `${role} ${profiles[role].model} ${profiles[role].effort} config file`);
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
  const { configPath } = fixture(t, profiles);
  const result = await model([], { configPath });

  assert.equal(result.exitCode, 0);
  const rows = profileRows(result.output);
  assert.match(rows[2], /^review\s+Codex default \(not pinned\)\s+medium\s+model: not set \(Codex chooses\); effort: package default$/);
  assert.match(rows[0], /config file$/);
  assert.match(rows[1], /config file$/);
});

test('partial profiles report model and effort provenance separately', async (t) => {
  const configuredId = randomUUID();
  const { configPath } = fixture(t, {
    scout: { model: configuredId }, build: { effort: 'max' }, review: {},
  });
  const result = await model([], { configPath });

  assert.equal(result.exitCode, 0);
  const rows = profileRows(result.output);
  assert.ok(rows[0].includes(configuredId));
  assert.match(rows[0], /medium\s+model: config file; effort: package default$/);
  assert.match(rows[1], /Codex default \(not pinned\)\s+max\s+model: not set \(Codex chooses\); effort: config file$/);
  assert.match(rows[2], /medium\s+model: not set \(Codex chooses\); effort: package default$/);
});

test('a missing config is shown as defaults without creating it', async (t) => {
  const { root } = fixture(t, {});
  const configPath = path.join(root, 'absent.json');
  const result = await model([], { configPath: path.relative(process.cwd(), configPath) });

  assert.equal(result.exitCode, 0);
  for (const row of profileRows(result.output)) assert.match(row, /medium\s+model: not set \(Codex chooses\); effort: package default$/);
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
  const cases = [['set'], ['speed'], ['unknown'], ['--json'], ['list', '--bundled'], ['list', 'extra']];
  for (const argv of cases) {
    const result = await model(argv, {
      configPath,
      fetchCatalogue: () => assert.fail('invalid arguments must not fetch a catalogue'),
    });
    assert.equal(result.exitCode, 2, argv.join(' '));
    assert.match(result.output, /unknown action|unexpected argument/);
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
  assert.equal(profileRows(result.stdout).length, 3);
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

test('Plan_56 additions stay below 400 lines and use role terminology', () => {
  const files = ['cli/model.mjs', 'cli/model-catalogue.mjs', 'bin/codex-bridge.mjs',
    'tests/cli/model.test.mjs', 'tests/cli/model-catalogue.test.mjs'];
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(source.trimEnd().split('\n').length <= 400, file);
    if (file.startsWith('cli/')) assert.doesNotMatch(source, /\bmode\b/, file);
  }
});
