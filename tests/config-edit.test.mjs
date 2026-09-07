/** Plan_56 D27: editing one decision must not freeze defaults or normalize other decisions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { editRunConfig } from '../src/home/lib/config-edit.mjs';
import { readRunConfig, DEFAULTS } from '../src/home/lib/run-config.mjs';
import { makeTempTree } from './temp-tree.mjs';

function fixture(raw) {
  const directory = makeTempTree('config-edit-');
  const file = path.join(directory, 'config.json');
  if (raw !== undefined) fs.writeFileSync(file, raw);
  return { directory, file };
}

for (const key of ['hooks', 'plugins']) {
  test(`${key} edits only its own value in a three-key file, byte for byte`, async () => {
    const raw = '\uFEFF{\r\n\t"' + key + '" : false,\r\n'
      + '\t"environment\\u0050aths" : [ "  cache/**  ", "", "emoji-😀", "quote\\\"}:[" ],\r\n'
      + '\t"models" : {"build" : { "model": " custom ", "effort": " high " }}\r\n}\r\n';
    const { directory, file } = fixture(raw);
    const effective = await editRunConfig({ key, value: true }, file);
    assert.equal(fs.readFileSync(file, 'utf8'), raw.replace(': false', ': true'));
    assert.equal(effective[key], true);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8').slice(1))).length, 3);
    assert.deepEqual(effective, readRunConfig(file));
    assert.deepEqual(fs.readdirSync(directory), ['config.json']);
  });
}

test('adding a switch leaves partial budgets and disabled retention exactly as written', async () => {
  const raw = '{ "budgets" : {"build": 7.50e0}, "retention": {"enabled": false, "days": "ignored"},'
    + ' "answerLanguage": " Spanish " }\n';
  const { file } = fixture(raw);
  await editRunConfig({ key: 'hooks', value: true }, file);
  const written = fs.readFileSync(file, 'utf8');
  assert.equal(written.replace(',\n  "hooks": true\n', ''), raw);
  assert.deepEqual(JSON.parse(written), { ...JSON.parse(raw), hooks: true });
  assert.equal(readRunConfig(file).budgets.scout, DEFAULTS.budgets.scout);
});

test('a missing file and parent are created holding only the requested key', async () => {
  const { directory } = fixture();
  const file = path.join(directory, 'new-home', 'config.json');
  await editRunConfig({ key: 'plugins', value: true }, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { plugins: true });
  assert.deepEqual(readRunConfig(file), { ...DEFAULTS, plugins: true });
});

test('structured edits preserve nested values belonging to other top-level keys', async () => {
  const raw = '{"models":{"build":{"model":" old "}},"environmentPaths":["keep", ""]}\n';
  const { file } = fixture(raw);
  await editRunConfig({ key: 'models', value: { build: { effort: 'high' } } }, file);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith(',"environmentPaths":["keep", ""]}\n'));
  assert.deepEqual(readRunConfig(file).models, { build: { effort: 'high' } });
});

test('the shared editor persists and removes speed without adding defaults or changing unrelated bytes', async () => {
  const speed = randomUUID();
  const raw = '{"models":{"build":{"model":"m","effort":"high"}},"environmentPaths":["keep", ""]}\n';
  const { directory, file } = fixture(raw);
  const profile = { model: 'm', effort: 'high' };
  await editRunConfig({ key: 'models', value: { build: { ...profile, speed } } }, file);
  assert.deepEqual(readRunConfig(file).models.build, { ...profile, speed });
  assert.ok(fs.readFileSync(file, 'utf8').endsWith(',"environmentPaths":["keep", ""]}\n'));
  await editRunConfig({ key: 'models', value: { build: profile } }, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { models: { build: profile }, environmentPaths: ['keep', ''] });
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});

test('escaped and repeated spellings of the requested key are all edited', async () => {
  const raw = '{"hooks":false,"h\\u006foks":false,"plugins":false}';
  const { file } = fixture(raw);
  await editRunConfig({ key: 'hooks', value: true }, file);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"hooks":true,"h\\u006foks":true,"plugins":false}');
  assert.equal(readRunConfig(file).hooks, true);
});

test('every invalid edit is refused by the reader and leaves the original bytes and directory unchanged', async () => {
  const changes = [
    { key: 'hooks', value: 'on' },
    { key: 'plugins', value: null },
    { key: 'hook', value: true },
    { key: 'environmentPaths', value: [1] },
    // Plan_56 D24: the value of a depth is no longer judged here, only its form — the live
    // catalogue judges the pair on write, and Codex judges it at run start.
    { key: 'models', value: { build: { effort: 'two words' } } },
    ...['', ' ', 'two words', 'line\nbreak', 1, null].map((speed) => ({ key: 'models', value: { build: { speed } } })),
    { key: 'budgets', value: { build: 0 } },
    { key: 'retention', value: { enabled: true, days: -1 } },
    { key: 'answerLanguage', value: '' },
  ];
  for (const change of changes) {
    const raw = '{\r\n  "hooks": false, "plugins": false\r\n}\r\n';
    const { directory, file } = fixture(raw);
    const rejected = fixture(JSON.stringify({ ...JSON.parse(raw), [change.key]: change.value }));
    let readerError;
    assert.throws(() => readRunConfig(rejected.file), (error) => {
      readerError = error.message.replace(rejected.file, file);
      return true;
    });
    await assert.rejects(editRunConfig(change, file), { message: readerError });
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.deepEqual(fs.readdirSync(directory), ['config.json']);
  }
});

test('rejection on a missing file creates neither a target nor temporary files', async () => {
  const { directory } = fixture();
  await assert.rejects(editRunConfig({ key: 'hooks', value: 1 }, path.join(directory, 'new', 'config.json')));
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('malformed, non-object, and unrelated invalid input cannot be silently overwritten', async () => {
  for (const raw of ['{"hooks":', 'null', '[]', '{"manualTypo":true}']) {
    const { directory, file } = fixture(raw);
    await assert.rejects(editRunConfig({ key: 'hooks', value: true }, file));
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.deepEqual(fs.readdirSync(directory), ['config.json']);
  }
});

test('an invalid value can be repaired by editing that key', async () => {
  const { file } = fixture('{"hooks":"on","plugins":false}');
  await editRunConfig({ key: 'hooks', value: true }, file);
  assert.deepEqual(readRunConfig(file), { ...DEFAULTS, hooks: true });
});

test('a read error other than a missing file is propagated without writing', async (t) => {
  const { directory, file } = fixture();
  t.mock.method(fsp, 'readFile', async () => {
    throw Object.assign(new Error('read denied'), { code: 'EACCES' });
  });
  await assert.rejects(editRunConfig({ key: 'hooks', value: true }, file), { code: 'EACCES' });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('the editor requires an explicit edit, not a replacement config', async () => {
  const { directory, file } = fixture();
  for (const change of [undefined, null, {}, { hooks: true }, { key: 'hooks' }, { reset: false },
    { reset: true, key: 'hooks', value: true }]) {
    await assert.rejects(editRunConfig(change, file), /requires/);
  }
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('a reset persists an empty object while the runtime still sees the defaults', async () => {
  const { file } = fixture('{"hooks":true,"plugins":true,"environmentPaths":[]}');
  assert.deepEqual(await editRunConfig({ reset: true }, file), DEFAULTS);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
  assert.deepEqual(readRunConfig(file), DEFAULTS);
});

test('rename publishes a complete sibling file and failure preserves the original', async (t) => {
  const raw = '{"hooks":false}\n';
  const { directory, file } = fixture(raw);
  let attempts = 0;
  t.mock.method(fsp, 'rename', async (temporary, target) => {
    attempts += 1;
    assert.equal(target, file);
    assert.equal(path.dirname(temporary), directory);
    assert.notEqual(temporary, file);
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.equal(fs.readFileSync(temporary, 'utf8'), '{"hooks":true}\n');
    throw new Error('rename refused');
  });
  await assert.rejects(editRunConfig({ key: 'hooks', value: true }, file), /rename refused/);
  assert.equal(attempts, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});

test('a partial temporary write is cleaned up without touching the target', async (t) => {
  const raw = '{"plugins":false}\n';
  const { directory, file } = fixture(raw);
  const open = fsp.open;
  t.mock.method(fsp, 'open', async (...args) => {
    const handle = await open(...args);
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async () => {
      await write('{');
      throw new Error('write interrupted');
    };
    return handle;
  });
  await assert.rejects(editRunConfig({ key: 'plugins', value: true }, file), /write interrupted/);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});

test('the CLI changes only its switch and reset keeps the existing printed state', () => {
  const { directory, file } = fixture('{"hooks":false,"budgets":{"build":7.5},"answerLanguage":" Spanish "}');
  const cli = fileURLToPath(new URL('../src/home/lib/run-config.mjs', import.meta.url));
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8', env: { ...process.env, CODEX_BRIDGE_HOME: directory },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  assert.match(run('hooks', 'on'), /hooks: on/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"hooks":true,"budgets":{"build":7.5},"answerLanguage":" Spanish "}');
  run('plugins', 'on');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    hooks: true, budgets: { build: 7.5 }, answerLanguage: ' Spanish ', plugins: true,
  });
  const reset = run('reset');
  assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
  const shown = run();
  assert.equal(reset.replace('Reset to defaults · ', 'File: '), shown);
  assert.deepEqual(readRunConfig(file), DEFAULTS);
});

test('a nested value is pasted at the depth of the key it replaces', async () => {
  // The serialized object knows its own shape but not how deep it lands: "models" sat at two
  // spaces while its first role sat at none, leaving valid JSON that no longer read as a file a
  // person edits by hand — which is the only reason this path writes over raw text at all.
  const { file } = fixture('{\n  "hooks": false,\n  "models": {\n    "review": { "model": "m" }\n  }\n}\n');
  await editRunConfig({ key: 'models', value: { build: { model: 'n', effort: 'high' } } }, file);
  const written = fs.readFileSync(file, 'utf8');
  assert.match(written, /\n {2}"models": \{\n {4}"build": \{\n {6}"model": "n",\n {6}"effort": "high"\n {4}\}\n {2}\}/);
  assert.deepEqual(readRunConfig(file).models, { build: { model: 'n', effort: 'high' } });
});

test('a nested value added to a file that lacks the key keeps the two-space margin', async () => {
  const { file } = fixture('{\n  "hooks": false\n}\n');
  await editRunConfig({ key: 'models', value: { scout: { effort: 'low' } } }, file);
  assert.match(
    fs.readFileSync(file, 'utf8'),
    /\n {2}"models": \{\n {4}"scout": \{\n {6}"effort": "low"\n {4}\}\n {2}\}\n\}/,
  );
});
