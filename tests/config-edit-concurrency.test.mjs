/**
 * Plan_56 D44: what the edit boundary does when someone else writes the same file.
 * Ordinary edits live in config-edit.test.mjs; competition is its own responsibility — a live
 * probe of three concurrent processes lost an edit while every byte comparison passed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { editRunConfig } from '../src/home/lib/config-edit.mjs';
import { makeTempTree } from './temp-tree.mjs';

function fixture(raw) {
  const directory = makeTempTree('config-edit-race-');
  const file = path.join(directory, 'config.json');
  if (raw !== undefined) fs.writeFileSync(file, raw);
  return { directory, file };
}

test('a concurrent edit retries the transformer on fresh profiles so both edits survive', async () => {
  // D40/D41: the old prepared-value writer silently replaced the other command's role edit.
  const initial = { build: { model: 'm' } };
  const intruder = { ...initial, scout: { effort: 'low' } };
  const { directory, file } = fixture(JSON.stringify({ models: initial }));
  let calls = 0;
  await editRunConfig('models', (current) => {
    calls += 1;
    assert.deepEqual(current, calls === 1 ? initial : intruder);
    if (calls === 1) fs.writeFileSync(file, JSON.stringify({ plugins: true, models: intruder }));
    return { ...current, review: { effort: 'high' } };
  }, file);
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    plugins: true, models: { ...intruder, review: { effort: 'high' } },
  });
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});

test('byte changes alone require a retry and retain the intruder formatting', async () => {
  const { directory, file } = fixture('{"hooks":false,"plugins":false}');
  const intruder = '\uFEFF{\r\n\t"hooks" : false,\r\n\t"plugins" : false\r\n}\r\n';
  let calls = 0;
  await editRunConfig('hooks', (current) => {
    calls += 1;
    assert.equal(current, false);
    if (calls === 1) fs.writeFileSync(file, intruder);
    return true;
  }, file);
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), intruder.replace('"hooks" : false', '"hooks" : true'));
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});

test('three conflicting attempts refuse the edit, name the file, and leave no temporary files', async () => {
  const { directory, file } = fixture('{"hooks":false}');
  let calls = 0;
  await assert.rejects(editRunConfig('hooks', () => {
    calls += 1;
    fs.writeFileSync(file, JSON.stringify({ hooks: false, environmentPaths: [`intruder-${calls}`] }));
    return true;
  }, file), (error) => {
    assert.ok(error.message.includes(file));
    assert.match(error.message, /config kept changing under the edit; nothing was written/);
    return true;
  });
  assert.equal(calls, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hooks: false, environmentPaths: ['intruder-3'] });
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});

test('creation of a previously missing target differs from the missing state and preserves the new key', async () => {
  const { directory, file } = fixture();
  let calls = 0;
  await editRunConfig('hooks', () => {
    calls += 1;
    if (calls === 1) fs.writeFileSync(file, '{"plugins":true}');
    return true;
  }, file);
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { plugins: true, hooks: true });
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});

test('removal of a previously present target retries with an absent key', async () => {
  const { directory, file } = fixture('{"hooks":false,"plugins":true}');
  const seen = [];
  await editRunConfig('hooks', (current) => {
    seen.push(current);
    if (seen.length === 1) fs.unlinkSync(file);
    return true;
  }, file);
  assert.deepEqual(seen, [false, undefined]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hooks: true });
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});

test('a comparison read error aborts and cleans the temporary file without overwriting the target', async (t) => {
  const raw = '{"hooks":false}\n';
  const { directory, file } = fixture(raw);
  const read = fs.readFileSync;
  let calls = 0;
  // The comparison reads synchronously for the same reason the rename does; only the first read
  // belongs to the edit, so later reads in this test are the assertions below.
  t.mock.method(fs, 'readFileSync', (...args) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('comparison denied'), { code: 'EACCES' });
    return read(...args);
  });
  await assert.rejects(editRunConfig('hooks', () => true, file), { code: 'EACCES', message: 'comparison denied' });
  assert.equal(calls, 1);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});

test('a second edit waits through the first transformer and both keys survive', { timeout: 2000 }, async (t) => {
  // Plan_56 D44: a byte comparison could pass in every process while one successful edit vanished.
  const { directory, file } = fixture('{}\n');
  let enter, release, attempted;
  const entered = new Promise((resolve) => { enter = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { attempted = resolve; });
  let firstCalls = 0, secondCalls = 0;
  const first = editRunConfig('hooks', async () => { firstCalls += 1; enter(); await held; return true; }, file);
  await entered;
  const open = fsp.open;
  t.mock.method(fsp, 'open', async (...args) => {
    try { return await open(...args); }
    catch (error) { if (args[0] === `${file}.lock`) attempted(); throw error; }
  });
  const second = editRunConfig('plugins', () => { secondCalls += 1; return true; }, file);
  try { await waiting; assert.equal(secondCalls, 0); }
  finally { release(); await Promise.all([first, second]); }
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hooks: true, plugins: true });
  assert.deepEqual(fs.readdirSync(directory), ['config.json']);
});
