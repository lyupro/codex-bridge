/** Guards the CLI/home pair exposed by the 2026-10-21 mixed-image guidance failure. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { homeImageCheck } from '../../cli/doctor-home-image.mjs';
import { diagnose } from '../../cli/doctor.mjs';
import { install } from '../../cli/install.mjs';
import { buildInstallPlan, packageInfo, readInstallRecord, recordTarget } from '../../cli/manifest.mjs';
import { codexProbe, hostFixture, runsRootFixture } from './doctor-fixtures.mjs';

async function installedHost(t) {
  const host = await hostFixture(t);
  assert.equal((await install({ host })).exitCode, 0);
  return { host, record: await readInstallRecord(host) };
}

test('a fresh real installation matches every planned brand file including package.json', async (t) => {
  const { host, record } = await installedHost(t);
  const plan = (await buildInstallPlan(host)).filter((item) => item.root === 'brand');
  assert.ok(plan.some((item) => item.relativeToRoot === 'package.json'));
  assert.deepEqual(await homeImageCheck(host, record), {
    key: 'homeImage', status: 'ok', value: `${plan.length} image file(s) on disk match this package`,
  });
});

test('changed bytes fail even when the recorded package identity matches', async (t) => {
  const { host, record } = await installedHost(t);
  await fs.appendFile(path.join(host.brandRoot, 'package.json'), '\n');
  const result = await homeImageCheck(host, record);
  const ownPackage = await packageInfo();
  assert.equal(result.status, 'fail');
  assert.match(result.value, /changed: package\.json/);
  assert.ok(result.value.includes(`(${ownPackage.name}@${ownPackage.version})`));
  assert.match(result.value, /run codex-bridge update --force with this same command to replace it/);
});

test('a deleted brand file is named as missing', async (t) => {
  const { host, record } = await installedHost(t);
  await fs.unlink(path.join(host.brandRoot, 'package.json'));
  const result = await homeImageCheck(host, record);
  assert.equal(result.status, 'fail');
  assert.match(result.value, /missing: package\.json/);
});

test('a recorded file from another image fails only while it still exists', async (t) => {
  const { host, record } = await installedHost(t);
  const file = { root: 'brand', path: 'obsolete-image.mjs' };
  record.files.push(file);
  await fs.writeFile(recordTarget(host, file), '// old image\n');
  const result = await homeImageCheck(host, record);
  assert.equal(result.status, 'fail');
  assert.match(result.value, /extra: obsolete-image\.mjs/);
  await fs.unlink(recordTarget(host, file));
  assert.equal((await homeImageCheck(host, record)).status, 'ok');
});

test('operator edits to seeded config and conventions are never compared', async (t) => {
  const { host, record } = await installedHost(t);
  await fs.writeFile(path.join(host.brandRoot, 'config.json'), '{"operator":true}\n');
  await fs.writeFile(host.brandConventionsPath, '# Operator decisions\n');
  assert.equal((await homeImageCheck(host, record)).status, 'ok');
});

test('changed paths are capped at five with an exact remainder count', async (t) => {
  const { host, record } = await installedHost(t);
  const items = (await buildInstallPlan(host)).filter((item) => item.root === 'brand').slice(0, 8);
  assert.equal(items.length, 8);
  for (const item of items) await fs.appendFile(item.target, '\nchanged\n');
  const result = await homeImageCheck(host, record);
  assert.equal(result.status, 'fail');
  assert.ok(result.value.startsWith(`changed: ${items.slice(0, 5).map((item) => item.relativeToRoot).join(', ')}, +3 more;`));
  for (const item of items.slice(5)) assert.ok(!result.value.includes(item.relativeToRoot));
});

test('no installation record warns before inspecting the host', async () => {
  assert.deepEqual(await homeImageCheck(null, null), {
    key: 'homeImage', status: 'warn', value: 'Home image was not checked; run codex-bridge install',
  });
});

test('a brand file replaced by a directory is unreadable rather than changed', async (t) => {
  const { host, record } = await installedHost(t);
  const target = path.join(host.brandRoot, 'package.json');
  await fs.unlink(target);
  await fs.mkdir(target);
  const result = await homeImageCheck(host, record);
  assert.equal(result.status, 'fail');
  assert.match(result.value, /unreadable: package\.json/);
});

test('unexpected plan errors become a warning with the error message', async () => {
  const result = await homeImageCheck({}, { files: [] });
  assert.equal(result.status, 'warn');
  assert.match(result.value, /host has no .* install target/);
});

test('diagnose places homeImage after files and fails a changed image despite a matching record', async (t) => {
  const { host } = await installedHost(t);
  await runsRootFixture(t);
  const options = { host, codexProbe, bridgeProbe: () => ({ available: true, value: 'test' }) };
  assert.equal((await diagnose(options)).exitCode, 0);
  await fs.appendFile(path.join(host.brandRoot, 'package.json'), '\n');
  const result = await diagnose(options);
  const filesIndex = result.checks.findIndex((item) => item.key === 'files');
  assert.equal(result.checks[filesIndex + 1].key, 'homeImage');
  assert.equal(result.checks[filesIndex + 1].status, 'fail');
  assert.equal(result.checks.find((item) => item.key === 'installation').status, 'ok');
  assert.equal(result.exitCode, 1);
});
