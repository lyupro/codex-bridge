/** Covers repeat uninstall when an incomplete home has no recorded owners (Plan_65 D9/D10). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { installRecordPath, readInstallRecord, recordTarget } from '../../cli/manifest.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { runsRoot } from '../../src/home/lib/runner/runs-root.mjs';
import { allFiles, formatOneRecord } from './host-fixture.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

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

async function orphanFixture(t, name = 'orphan') {
  const root = makeTempTree(`bridge-uninstall-${name}-`);
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
  await install({ host });
  const recordPath = installRecordPath(host);
  await fs.writeFile(recordPath, `${JSON.stringify(await formatOneRecord(host), null, 2)}\n`);
  const record = await readInstallRecord(host);
  const imageFiles = record.files.filter((file) => file.root === 'brand');
  const configBefore = await fs.readFile(host.brandConfigPath);
  const prompt = countingPrompt('no');
  const initial = await uninstall({ host, isTTY: true, prompt });
  assert.equal(prompt.calls, 1);
  assert.equal(initial.exitCode, 1);
  const orphanRecord = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  assert.deepEqual(orphanRecord.owners, {});
  assert.equal(orphanRecord.inventory, 'incomplete');
  assert.ok(orphanRecord.legacy);
  return { root, host, recordPath, imageFiles, configBefore };
}

test('repeat uninstall can remove an orphaned image and record while keeping config.json', async (t) => {
  const state = await orphanFixture(t);
  const prompt = countingPrompt('yes');
  const result = await uninstall({ host: state.host, isTTY: true, prompt });
  assert.equal(prompt.calls, 1);
  assert.equal(result.exitCode, 0);
  const lines = result.output.split('\n');
  assert.ok(lines.includes(`Removed the installation record of ${state.host.brandRoot}.`));
  assert.ok(lines.includes(`Removed ${state.imageFiles.length} image file(s) from ${state.host.brandRoot}.`));
  const kept = `Kept 2 operator file(s) in ${state.host.brandRoot} for --purge: config.json, conventions.md`;
  assert.equal(lines.filter((line) => line === kept).length, 1);
  assert.equal(lines.at(-1), `Run artifacts in ${runsRoot()} are outside uninstall and stay.`);
  assert.doesNotMatch(result.output, /Removed the shared image/);
  await assert.rejects(() => fs.access(state.recordPath), { code: 'ENOENT' });
  for (const file of state.imageFiles) await assert.rejects(() => fs.access(recordTarget(state.host, file)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(state.host.brandConfigPath), state.configBefore);
});

// Plan_65 D12 item 7: an edited member must survive without a blanket image-removal claim.
test('repeat uninstall preserves an edited orphan image member and reports it', async (t) => {
  const state = await orphanFixture(t, 'edited');
  const imageFile = state.imageFiles.find((file) => file.path.endsWith('.mjs'));
  assert.ok(imageFile);
  const target = recordTarget(state.host, imageFile);
  const edited = Buffer.from(`${await fs.readFile(target, 'utf8')}\n// operator edit\n`);
  await fs.writeFile(target, edited);
  const prompt = countingPrompt('yes');
  const result = await uninstall({ host: state.host, isTTY: true, prompt });
  assert.equal(prompt.calls, 1);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(await fs.readFile(target), edited);
  const lines = result.output.split('\n');
  assert.ok(lines.includes(`Left brand/${imageFile.path} (changed)`));
  assert.ok(lines.includes(`Removed the installation record of ${state.host.brandRoot}.`));
  assert.doesNotMatch(result.output, /Removed the shared image/);
  assert.equal(lines.at(-1), `Run artifacts in ${runsRoot()} are outside uninstall and stay.`);
  await assert.rejects(() => fs.access(state.recordPath), { code: 'ENOENT' });
});

test('repeat uninstall keeps the orphaned image and record when answered no', async (t) => {
  const state = await orphanFixture(t);
  const recordBefore = await fs.readFile(state.recordPath);
  const prompt = countingPrompt('no');
  const result = await uninstall({ host: state.host, isTTY: true, prompt });
  assert.equal(prompt.calls, 1);
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes(`Left the shared image in ${state.host.brandRoot} because no host is recorded as using it and the inventory is incomplete.`));
  const recordLine = `Kept the installation record of ${state.host.brandRoot} (no host is recorded as using it).`;
  assert.ok(result.output.split('\n').includes(recordLine));
  assert.ok(result.output.includes(hintFor(state.host)));
  assert.deepEqual(await fs.readFile(state.recordPath), recordBefore);
  for (const file of state.imageFiles) await fs.access(recordTarget(state.host, file));
});

test('cancelling orphan removal leaves record and settings bytes unchanged', async (t) => {
  const state = await orphanFixture(t);
  const recordBefore = await fs.readFile(state.recordPath);
  const settingsBefore = await fs.readFile(state.host.settingsPath);
  const prompt = countingPrompt('cancel');
  const result = await uninstall({ host: state.host, isTTY: true, prompt });
  assert.equal(prompt.calls, 1);
  assert.deepEqual(result, { exitCode: 130, output: 'Cancelled; nothing was changed.' });
  assert.deepEqual(await fs.readFile(state.recordPath), recordBefore);
  assert.deepEqual(await fs.readFile(state.host.settingsPath), settingsBefore);
});

test('without a terminal orphan removal is kept without prompting', async (t) => {
  const state = await orphanFixture(t);
  const recordBefore = await fs.readFile(state.recordPath);
  const prompt = countingPrompt('yes');
  const result = await uninstall({ host: state.host, isTTY: false, prompt });
  assert.equal(prompt.calls, 0);
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes(hintFor(state.host)));
  assert.deepEqual(await fs.readFile(state.recordPath), recordBefore);
});

test('another host with no marks reaches the orphan question instead of reporting not installed', async (t) => {
  const state = await orphanFixture(t);
  const other = resolveHost({
    host: path.join(state.root, 'other-host'),
    codexHome: path.join(state.root, 'codex-home'),
    brandRoot: state.host.brandRoot,
  });
  const prompt = countingPrompt('no');
  const result = await uninstall({ host: other, isTTY: true, prompt });
  assert.equal(prompt.calls, 1);
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.output, /codex-bridge is not installed/);
});

test('orphan dry run does not prompt or change record bytes', async (t) => {
  const state = await orphanFixture(t);
  const filesBefore = await allFiles(state.root);
  const recordBefore = await fs.readFile(state.recordPath);
  const prompt = countingPrompt('yes');
  const result = await uninstall({ host: state.host, dryRun: true, isTTY: true, prompt });
  const expected = `A real run would ask whether to remove the shared image of ${state.host.brandRoot}: no host is recorded as using it.`;
  assert.equal(prompt.calls, 0);
  assert.equal(result.exitCode, 1);
  const lines = result.output.split('\n');
  const questionIndex = lines.indexOf(expected);
  assert.ok(questionIndex >= 0);
  assert.equal(lines[questionIndex + 1], 'If the answer is yes:');
  const recordLine = `Would remove the installation record of ${state.host.brandRoot}.`;
  assert.ok(lines.indexOf(recordLine) > questionIndex + 1);
  assert.deepEqual(await fs.readFile(state.recordPath), recordBefore);
  assert.deepEqual(await allFiles(state.root), filesBefore);
});
