/** Plan_65 D9: install asks whether the inventory is complete at the transition, and only there. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { install } from '../../cli/install.mjs';
import { installRecordPath } from '../../cli/install-record.mjs';
import { fixture, formatOneRecord } from './host-fixture.mjs';

async function formatOneHost(t) {
  const { host } = await fixture(t);
  await install({ host });
  await fs.writeFile(installRecordPath(host), `${JSON.stringify(await formatOneRecord(host), null, 2)}
`);
  return host;
}

async function rawInstallRecord(host) {
  return JSON.parse(await fs.readFile(installRecordPath(host), 'utf8'));
}

function countingPrompt(answer) {
  const prompt = async () => { prompt.calls += 1; return answer; };
  prompt.calls = 0;
  return prompt;
}

for (const [answer, expected, interactive] of [
  ['yes', 'complete', true],
  ['no', 'incomplete', true],
  [undefined, 'incomplete', false],
]) {
  test(`install over a format-1 record records ${expected} (${interactive ? `prompt ${answer}` : 'no TTY'})`, async (t) => {
    const host = await formatOneHost(t);
    const prompt = countingPrompt(answer);
    const result = await install({ host, isTTY: interactive, prompt });
    const record = await rawInstallRecord(host);

    assert.equal(result.exitCode, 0);
    assert.equal(prompt.calls, interactive ? 1 : 0);
    assert.equal(record.format, 2);
    assert.equal(record.inventory, expected);
    assert.equal(Boolean(record.legacy), expected === 'incomplete');
    // Identical package files: the migration itself is the work, so "nothing to do" must not win.
    assert.doesNotMatch(result.output, /nothing to do/);
    assert.match(result.output, expected === 'complete'
      ? /Recorded this host as the only one using/
      : /The inventory stays incomplete/);
  });
}

test('install cancelled at the transition exits 130 and leaves the record and settings byte-identical', async (t) => {
  const host = await formatOneHost(t);
  const before = await Promise.all([fs.readFile(installRecordPath(host)), fs.readFile(host.settingsPath)]);
  const prompt = countingPrompt('cancel');

  const result = await install({ host, isTTY: true, prompt });

  assert.deepEqual(result, { exitCode: 130, output: 'Cancelled; nothing was changed.' });
  assert.equal(prompt.calls, 1);
  assert.deepEqual(await Promise.all([fs.readFile(installRecordPath(host)), fs.readFile(host.settingsPath)]), before);
});

test('install asks only at a transition: never on a fresh home or over a format-2 record', async (t) => {
  const fresh = await fixture(t);
  const freshResult = await install({ host: fresh.host, isTTY: true, prompt: async () => assert.fail('fresh home asked') });
  assert.equal(freshResult.exitCode, 0);
  assert.equal((await rawInstallRecord(fresh.host)).inventory, 'complete');

  const existing = await fixture(t);
  await install({ host: existing.host });
  const prompt = countingPrompt('yes');
  const existingResult = await install({ host: existing.host, isTTY: true, prompt });
  assert.equal(existingResult.exitCode, 0);
  assert.equal(prompt.calls, 0);
  assert.equal((await rawInstallRecord(existing.host)).format, 2);
});

test('install dry run describes the transition question and neither asks nor writes', async (t) => {
  const host = await formatOneHost(t);
  const prompt = countingPrompt('yes');
  const result = await install({ host, dryRun: true, isTTY: true, prompt });
  assert.ok(result.output.includes(`A real run would ask whether this host is the only one using ${host.brandRoot}.`));
  assert.equal(prompt.calls, 0);
  assert.equal((await rawInstallRecord(host)).format, undefined);
});

test('a nested install records the answer it was handed and never asks again', async (t) => {
  const { host } = await fixture(t);
  const prompt = countingPrompt('yes');
  const result = await install({
    host, isTTY: true, prompt,
    inventoryTransition: { transition: true, homeHadImage: true, inventory: 'incomplete' },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(prompt.calls, 0);
  assert.equal((await rawInstallRecord(host)).inventory, 'incomplete');
});
