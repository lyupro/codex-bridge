/** Guards root-only user tier reads and the build/read-only provenance asymmetry (Plan_56). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readCodexUserTier } from '../../cli/codex-user-config.mjs';
import { model } from '../../cli/model.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function fixture(t) {
  const root = makeTempTree('codex-user-config-');
  t.after(() => removeTempTree(root));
  return { root, codexHome: root, configPath: path.join(root, 'config.json'),
    userConfigPath: path.join(root, 'config.toml') };
}

test('reads a double-quoted root tier before the first table, preserving its identifier', (t) => {
  const { codexHome, userConfigPath } = fixture(t);
  const tier = randomUUID();
  fs.writeFileSync(userConfigPath,
    `# [not a table]\nmodel = "fixture-model"\n  service_tier = "${tier}" # chosen\n[profile]\nservice_tier = "nested"\n`);
  assert.equal(readCodexUserTier({ codexHome }), tier);
});

test('reads single quotes, tabs and CRLF without stripping a quoted hash', (t) => {
  const { codexHome, userConfigPath } = fixture(t);
  const tier = `${randomUUID()}#quoted`;
  fs.writeFileSync(userConfigPath, `\uFEFF# comment\r\n\tservice_tier\t=\t'${tier}'\t# outside\r\n`);
  assert.equal(readCodexUserTier({ codexHome }), tier);
});

test('does not read a tier below any first table header, including indented array tables', (t) => {
  const { codexHome, userConfigPath } = fixture(t);
  for (const header of ['[profile]', '  [profile.nested] # table', '\t[[profiles]]']) {
    fs.writeFileSync(userConfigPath, `model = "fixture"\n${header}\nservice_tier = "nested"\n`);
    assert.equal(readCodexUserTier({ codexHome }), '', header);
  }
});

test('absent, commented, differently named and malformed tier keys are not set', (t) => {
  const { codexHome, userConfigPath } = fixture(t);
  for (const content of ['', '# service_tier = "comment"', 'other_service_tier = "other"',
    'service_tier =', 'service_tier = "unterminated', 'service_tier = ""']) {
    fs.writeFileSync(userConfigPath, content);
    assert.equal(readCodexUserTier({ codexHome }), '', content);
  }
});

// Found by an independent review of Plan_56 step 4: a multi-line literal is valid TOML and can
// hold anything, so a line-at-a-time scan answered with someone's prose. Both halves matter — the
// text inside must be ignored, and the real assignment after the literal must still be found.
test('text inside a multi-line literal is not read as configuration', (t) => {
  const { codexHome, userConfigPath } = fixture(t);
  const real = randomUUID();
  for (const delimiter of ['"""', "'''"]) {
    fs.writeFileSync(userConfigPath,
      `notes = ${delimiter}\nservice_tier = "from-inside-a-string"\n[fake.section]\n${delimiter}\n`
      + `service_tier = "${real}"\n`);
    assert.equal(readCodexUserTier({ codexHome }), real, delimiter);
  }
});

test('a table header inside a multi-line literal does not end the root section', (t) => {
  const { codexHome, userConfigPath } = fixture(t);
  fs.writeFileSync(userConfigPath, 'notes = """\n[profile]\n"""\nservice_tier = "after"\n');
  assert.equal(readCodexUserTier({ codexHome }), 'after');
});

test('a null argument returns not set rather than escaping the error boundary', () => {
  assert.doesNotThrow(() => readCodexUserTier(null));
  assert.equal(typeof readCodexUserTier(null), 'string');
});

test('a missing config or directory is not set and is never created', (t) => {
  const { root, codexHome, userConfigPath } = fixture(t);
  assert.equal(readCodexUserTier({ codexHome }), '');
  assert.equal(fs.existsSync(userConfigPath), false);
  const missingHome = path.join(root, 'missing');
  assert.equal(readCodexUserTier({ codexHome: missingHome }), '');
  assert.equal(fs.existsSync(missingHome), false);
});

test('an unreadable config never throws', (t) => {
  const { codexHome } = fixture(t);
  t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  assert.equal(readCodexUserTier({ codexHome }), '');
});

test('uses CODEX_HOME when set and the host resolver home directory otherwise', (t) => {
  const { root } = fixture(t);
  const homedir = path.join(root, 'home');
  const defaultDir = path.join(homedir, '.codex');
  const overrideDir = path.join(root, 'override');
  const defaultTier = randomUUID(), overrideTier = randomUUID();
  for (const [directory, tier] of [[defaultDir, defaultTier], [overrideDir, overrideTier]]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'config.toml'), `service_tier = "${tier}"\n`);
  }
  const originalCodexHome = process.env.CODEX_HOME;
  t.after(() => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  });
  process.env.CODEX_HOME = overrideDir;
  assert.equal(readCodexUserTier({ homedir }), overrideTier);
  delete process.env.CODEX_HOME;
  assert.equal(readCodexUserTier({ homedir }), defaultTier);
});

test('the unpinned build row names the current user tier while read-only roles ignore it', async (t) => {
  const { codexHome, configPath, userConfigPath } = fixture(t);
  const config = JSON.stringify({ models: {} });
  fs.writeFileSync(configPath, config);
  for (const tier of [randomUUID(), randomUUID()]) {
    const userConfig = `service_tier = "${tier}"\n`;
    fs.writeFileSync(userConfigPath, userConfig);
    const result = await model([], { configPath, codexHome });
    assert.equal(result.exitCode, 0, result.output);
    for (const role of ['scout', 'build', 'review', 'advisor']) {
      const row = result.output.split('\n').find((line) => line.startsWith(role));
      assert.match(row, /\smedium\s+not pinned\s/, 'the speed column still describes the package pin');
      if (role === 'build') assert.ok(row.endsWith(`speed: operator Codex config (${tier})`), row);
      else {
        assert.match(row, /speed: not pinned \(operator Codex config not read\)$/);
        assert.equal(row.includes(tier), false);
      }
    }
    assert.equal(fs.readFileSync(userConfigPath, 'utf8'), userConfig);
    assert.equal(fs.readFileSync(configPath, 'utf8'), config);
  }
});

test('package tier pins take precedence over the user tier for every role', async (t) => {
  const { codexHome, configPath, userConfigPath } = fixture(t);
  const userTier = randomUUID();
  const models = Object.fromEntries(['scout', 'build', 'review', 'advisor'].map((role) =>
    [role, { model: randomUUID(), effort: 'high', speed: randomUUID() }]));
  fs.writeFileSync(configPath, JSON.stringify({ models }));
  fs.writeFileSync(userConfigPath, `service_tier = "${userTier}"\n`);
  const result = await model([], { configPath, codexHome });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.output.includes(userTier), false);
  for (const [role, profile] of Object.entries(models)) {
    const row = result.output.split('\n').find((line) => line.startsWith(role));
    assert.ok(row.includes(profile.speed), row);
    assert.match(row, /; speed: config file/);
    assert.equal(row.includes('operator Codex config not read'), role !== 'build');
  }
});

test('a table-only user tier is not attributed to build', async (t) => {
  const { codexHome, configPath, userConfigPath } = fixture(t);
  fs.writeFileSync(configPath, JSON.stringify({ models: {} }));
  fs.writeFileSync(userConfigPath, '[profile]\nservice_tier = "nested"\n');
  const result = await model([], { configPath, codexHome });
  assert.equal(result.exitCode, 0, result.output);
  const build = result.output.split('\n').find((line) => line.startsWith('build'));
  assert.match(build, /; speed: not pinned$/);
  assert.doesNotMatch(build, /operator Codex config/);
});
