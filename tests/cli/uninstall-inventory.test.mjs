/** Covers the last known owner's question for incomplete uninstall inventories (Plan_65 D9 item 2). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import {
  installRecordPath,
  readInstallRecord,
  recordTarget,
} from '../../cli/manifest.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { allFiles, fixture, formatOneRecord } from './host-fixture.mjs';

async function formatOneFixture(t) {
  const setup = await fixture(t);
  await install({ host: setup.host });
  const recordPath = installRecordPath(setup.host);
  await fs.writeFile(recordPath, `${JSON.stringify(await formatOneRecord(setup.host), null, 2)}\n`);
  const record = await readInstallRecord(setup.host);
  return {
    ...setup,
    recordPath,
    imageFiles: record.files.filter((file) => file.root === 'brand'),
    hostFiles: record.files.filter((file) => file.root !== 'brand'),
  };
}

function countingPrompt(answer) {
  const prompt = async () => {
    prompt.calls += 1;
    return answer;
  };
  prompt.calls = 0;
  return prompt;
}

function hintFor(host) {
  return `Run codex-bridge uninstall --host "${host.root}" again in a terminal`;
}

async function assertGone(host, files) {
  for (const file of files) {
    await assert.rejects(() => fs.access(recordTarget(host, file)), { code: 'ENOENT' });
  }
}

async function assertPresent(host, files) {
  for (const file of files) await fs.access(recordTarget(host, file));
}

// "no" and "no terminal" must land on the same state: own side gone, image and an empty,
// incomplete record kept, so a later run in a terminal reaches the question again.
async function assertImageKept(state, result) {
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes(hintFor(state.host)));
  const record = JSON.parse(await fs.readFile(state.recordPath, 'utf8'));
  assert.deepEqual(record.owners, {});
  assert.equal(record.inventory, 'incomplete');
  assert.ok(record.legacy);
  await assertPresent(state.host, state.imageFiles);
  await assertGone(state.host, state.hostFiles);
}

test('format-1 last owner can confirm removal of the image and record', async (t) => {
  const state = await formatOneFixture(t);
  const prompt = countingPrompt('yes');

  const result = await uninstall({ host: state.host, isTTY: true, prompt });

  assert.equal(prompt.calls, 1);
  assert.equal(result.exitCode, 0);
  await assert.rejects(() => fs.access(state.recordPath), { code: 'ENOENT' });
  await assertGone(state.host, state.imageFiles);
});

test('format-1 last owner can keep the image and receives the removal hint', async (t) => {
  const state = await formatOneFixture(t);
  const prompt = countingPrompt('no');

  const result = await uninstall({ host: state.host, isTTY: true, prompt });

  assert.equal(prompt.calls, 1);
  await assertImageKept(state, result);
});

test('without a terminal the last owner keeps the image without being asked', async (t) => {
  const state = await formatOneFixture(t);
  const prompt = countingPrompt('yes');

  const result = await uninstall({ host: state.host, isTTY: false, prompt });

  assert.equal(prompt.calls, 0);
  await assertImageKept(state, result);
});

test('cancel leaves settings, record, and image unchanged', async (t) => {
  const state = await formatOneFixture(t);
  const settingsBefore = await fs.readFile(state.host.settingsPath);
  const recordBefore = await fs.readFile(state.recordPath);
  const prompt = countingPrompt('cancel');

  const result = await uninstall({ host: state.host, isTTY: true, prompt });

  assert.equal(prompt.calls, 1);
  assert.deepEqual(result, { exitCode: 130, output: 'Cancelled; nothing was changed.' });
  assert.deepEqual(await fs.readFile(state.host.settingsPath), settingsBefore);
  assert.deepEqual(await fs.readFile(state.recordPath), recordBefore);
  await assertPresent(state.host, state.imageFiles);
});

test('complete format-2 image with two owners never prompts', async (t) => {
  const setup = await fixture(t);
  const second = resolveHost({
    host: path.join(setup.root, 'second-host'),
    codexHome: path.join(setup.root, 'codex-home'),
    brandRoot: path.join(setup.root, 'brand'),
  });
  await install({ host: setup.host });
  await install({ host: second });
  const record = JSON.parse(await fs.readFile(installRecordPath(setup.host), 'utf8'));
  assert.equal(record.inventory, 'complete');
  assert.equal(Object.keys(record.owners).length, 2);
  const prompt = countingPrompt('yes');

  const result = await uninstall({ host: setup.host, isTTY: true, prompt });

  assert.equal(prompt.calls, 0);
  assert.equal(result.exitCode, 0);
});

test('dry-run reports the pending last-owner question without prompting or changing files', async (t) => {
  const state = await formatOneFixture(t);
  const filesBefore = await allFiles(state.root);
  const recordBefore = await fs.readFile(state.recordPath);
  const prompt = countingPrompt('yes');

  const result = await uninstall({ host: state.host, dryRun: true, isTTY: true, prompt });

  const expected = `A real run would ask whether ${state.host.root} is the last host using ${state.host.brandRoot}.`;
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.split('\n').filter((line) => line === expected).length, 1);
  assert.equal(prompt.calls, 0);
  assert.deepEqual(await allFiles(state.root), filesBefore);
  assert.deepEqual(await fs.readFile(state.recordPath), recordBefore);
});

test('an already empty owner set does not ask the last-owner question', async (t) => {
  const state = await formatOneFixture(t);
  await uninstall({ host: state.host, isTTY: false });
  const prompt = countingPrompt('yes');

  const result = await uninstall({ host: state.host, isTTY: true, prompt });

  assert.equal(prompt.calls, 0);
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.output, /would ask whether/);
});
