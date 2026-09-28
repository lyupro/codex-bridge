/** Plan_65 D9: verifies update asks before legacy changes and hands one answer to install. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { install } from '../../cli/install.mjs';
import {
  installRecordPath,
  recordTarget,
} from '../../cli/manifest.mjs';
import { update } from '../../cli/update.mjs';
import { fixture, packageFixture } from './update-fixtures.mjs';
import { formatOneRecord } from './host-fixture.mjs';

async function makeFormatOneHost(t) {
  const { host } = await fixture(t);
  await install({ host });
  await fs.writeFile(installRecordPath(host), `${JSON.stringify(await formatOneRecord(host), null, 2)}\n`);
  return host;
}

function countingPrompt(answer) {
  const prompt = async () => {
    prompt.calls += 1;
    return answer;
  };
  prompt.calls = 0;
  return prompt;
}

test('update asks once for a format-1 transition and records the answer without legacy', async (t) => {
  const host = await makeFormatOneHost(t);
  const prompt = countingPrompt('yes');

  const result = await update({ host, isTTY: true, prompt });
  const record = JSON.parse(await fs.readFile(installRecordPath(host), 'utf8'));

  assert.equal(result.exitCode, 0);
  assert.equal(prompt.calls, 1);
  assert.equal(record.format, 2);
  assert.equal(record.inventory, 'complete');
  assert.equal(Object.hasOwn(record, 'legacy'), false);
  assert.ok(result.output.includes(`Recorded this host as the only one using ${host.brandRoot}.`));
});

test('update cancellation leaves orphan files, hook registrations, and the record untouched', async (t) => {
  const { root, host } = await fixture(t);
  const oldPackage = await packageFixture(root, 'old-package', { extraFile: 'obsolete.txt' });
  await install({ host, packageRoot: oldPackage });
  const record = await formatOneRecord(host);
  const orphan = record.files.find((file) => file.path.endsWith('obsolete.txt'));
  assert.ok(orphan);
  const orphanPath = recordTarget(host, orphan);
  const oldHook = record.hooks[0];
  assert.ok(oldHook);
  // Plan_65 D9: a valid retired hook entry makes the cancellation guard cover hook removal.
  const staleHookPath = `retired/${oldHook.path.split('/').at(-1)}`;
  const hookFingerprint = record.fingerprints[oldHook.root][oldHook.path];
  assert.ok(hookFingerprint);
  record.files.push({ root: oldHook.root, path: staleHookPath });
  record.fingerprints[oldHook.root][staleHookPath] = hookFingerprint;
  record.hooks[0] = { ...oldHook, path: staleHookPath };
  await fs.writeFile(installRecordPath(host), `${JSON.stringify(record, null, 2)}\n`);

  const before = {
    record: await fs.readFile(installRecordPath(host)),
    orphan: await fs.readFile(orphanPath),
    settings: await fs.readFile(host.settingsPath),
  };
  const settings = JSON.parse(before.settings.toString('utf8'));
  assert.ok(settings.hooks[oldHook.event]?.length);
  const prompt = countingPrompt('cancel');

  const result = await update({ host, isTTY: true, prompt });

  assert.deepEqual(result, { exitCode: 130, output: 'Cancelled; nothing was changed.' });
  assert.equal(prompt.calls, 1);
  assert.deepEqual(await fs.readFile(installRecordPath(host)), before.record);
  assert.deepEqual(await fs.readFile(orphanPath), before.orphan);
  assert.deepEqual(await fs.readFile(host.settingsPath), before.settings);
});

test('an otherwise current format-1 installation migrates instead of reporting up to date', async (t) => {
  const host = await makeFormatOneHost(t);
  const prompt = countingPrompt('yes');

  const result = await update({ host, isTTY: false, prompt });
  const record = JSON.parse(await fs.readFile(installRecordPath(host), 'utf8'));

  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.output, /up to date/i);
  assert.equal(prompt.calls, 0);
  assert.equal(record.format, 2);
  assert.equal(record.inventory, 'incomplete');
  assert.equal(Object.hasOwn(record, 'legacy'), true);
  assert.ok(result.output.includes('The inventory stays incomplete:'));
});

test('update over a format-2 record never asks', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const prompt = countingPrompt('yes');

  const result = await update({ host, isTTY: true, prompt });

  assert.equal(result.exitCode, 0);
  assert.equal(prompt.calls, 0);
  assert.match(result.output, /up to date/i);
});

test('dry-run describes the transition question without prompting or migrating', async (t) => {
  const host = await makeFormatOneHost(t);
  const recordPath = installRecordPath(host);
  const before = await fs.readFile(recordPath);
  const prompt = countingPrompt('yes');

  const result = await update({ host, dryRun: true, isTTY: true, prompt });

  assert.equal(result.exitCode, 0);
  assert.ok(result.output.includes(
    `A real run would ask whether this host is the only one using ${host.brandRoot}.`,
  ));
  assert.equal(prompt.calls, 0);
  assert.deepEqual(await fs.readFile(recordPath), before);
});