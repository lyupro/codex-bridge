/** Guards Plan_65 D12: the normal uninstall reports its plan and actual removal outcomes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { install } from '../../cli/install.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import {
  contentFingerprint, installRecordPath, legacyInstallRecordPath, readInstallRecord, recordTarget,
} from '../../cli/manifest.mjs';
import { runsRoot } from '../../src/home/lib/runner/runs-root.mjs';
import { allFiles, fixture, formatOneRecord } from './host-fixture.mjs';

const artifactsLine = () => `Run artifacts in ${runsRoot()} are outside uninstall and stay.`;

// D12 item 7 and D13 preserve edited lib bytes while retiring the last owner's record.
test('last-owner uninstall names an edited image file without claiming the shared image was removed', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const record = await readInstallRecord(host);
  const imageFile = record.files.find((file) => file.root === 'brand' && file.path.startsWith('lib/'));
  assert.ok(imageFile);
  const target = recordTarget(host, imageFile);
  await fs.appendFile(target, '\noperator edit\n');
  const edited = await fs.readFile(target);

  const result = await uninstall({ host });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(await fs.readFile(target), edited);
  assert.ok(result.output.split('\n').includes(`Left brand/${imageFile.path} (changed)`));
  assert.match(result.output, /^Removed \d+ image file\(s\) from /m);
  assert.doesNotMatch(result.output, /^Removed brand\//m);
  assert.doesNotMatch(result.output, /Removed the shared image/);
  await assert.rejects(() => fs.access(installRecordPath(host)), { code: 'ENOENT' });
  assert.equal(result.output.split('\n').at(-1), artifactsLine());
});

// D13 moves the combined preservation proof onto uninstall instead of a retired remover's private API.
test('dry-run uninstall counts unchanged image files and preserves edited bytes and the record', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const record = await readInstallRecord(host);
  const imageFiles = record.files.filter((file) => file.root === 'brand');
  const changed = imageFiles.find((file) => file.path.startsWith('lib/'));
  assert.ok(changed);
  const unchanged = imageFiles.find((file) => file.path !== changed.path);
  assert.ok(unchanged);
  const changedTarget = recordTarget(host, changed);
  const unchangedTarget = recordTarget(host, unchanged);
  const edited = Buffer.from('dry-run operator edit\n');
  await fs.writeFile(changedTarget, edited);
  const original = await fs.readFile(unchangedTarget);
  const recordBefore = await fs.readFile(installRecordPath(host));

  const result = await uninstall({ host, dryRun: true });

  assert.equal(result.exitCode, 0);
  const expected = `Would remove ${imageFiles.length - 1} image file(s) from ${host.brandRoot}`;
  assert.ok(result.output.split('\n').some((line) => line.startsWith(expected)), result.output);
  assert.ok(result.output.split('\n').includes(`Would leave brand/${changed.path} (changed)`));
  assert.deepEqual(await fs.readFile(unchangedTarget), original);
  assert.deepEqual(await fs.readFile(changedTarget), edited);
  assert.deepEqual(await fs.readFile(installRecordPath(host)), recordBefore);
});

// D10 detachment and D12's record line must agree before a dry run promises any record mutation.
test('dry-run uninstall keeps the record when settings prevent hook removal', async (t) => {
  const { root, host } = await fixture(t);
  await install({ host });
  await fs.writeFile(host.settingsPath, '{"hooks":[');
  const recordBefore = await fs.readFile(installRecordPath(host));
  const settingsBefore = await fs.readFile(host.settingsPath);
  const before = await allFiles(root);

  const result = await uninstall({ host, dryRun: true });

  const expected = `Would keep ${host.root} in the installation record because its hooks could not be removed.`;
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.split('\n').filter((line) => line === expected).length, 1);
  assert.match(result.output, /Would leave the shared image .* because this host's hooks could not be removed/);
  assert.doesNotMatch(result.output, /Would remove .*installation record/);
  assert.deepEqual(await fs.readFile(installRecordPath(host)), recordBefore);
  assert.deepEqual(await fs.readFile(host.settingsPath), settingsBefore);
  assert.deepEqual(await allFiles(root), before);
  assert.equal(result.output.split('\n').at(-1), artifactsLine());
});

// D12 item 4 treats a link as unsafe in a dry run, preserving both the junction and outside bytes.
test('dry-run uninstall names image members behind a link and exits nonzero', async (t) => {
  const { root, host } = await fixture(t);
  await install({ host });
  const record = await readInstallRecord(host);
  const relativeFolder = 'lib/runner';
  const members = record.files.filter((file) => file.root === 'brand'
    && file.path.startsWith(`${relativeFolder}/`));
  assert.ok(members.length > 0);
  const folder = path.join(host.brandRoot, relativeFolder);
  const outside = path.join(root, 'outside-runner');
  await fs.rename(folder, outside);
  await fs.symlink(outside, folder, 'junction');
  const before = await allFiles(root);
  const recordBefore = await fs.readFile(installRecordPath(host));
  const bytes = new Map();
  for (const member of members) bytes.set(member.path, await fs.readFile(recordTarget(host, member)));

  const result = await uninstall({ host, dryRun: true });

  assert.equal(result.exitCode, 1);
  assert.equal((await fs.lstat(folder)).isSymbolicLink(), true);
  for (const member of members) {
    const expected = `Would leave brand/${member.path} (link at ${relativeFolder})`;
    assert.ok(result.output.split('\n').includes(expected));
    assert.deepEqual(await fs.readFile(recordTarget(host, member)), bytes.get(member.path));
  }
  assert.deepEqual(await allFiles(root), before);
  assert.deepEqual(await fs.readFile(installRecordPath(host)), recordBefore);
  assert.equal(result.output.split('\n').at(-1), artifactsLine());
});

// D10 rejects a past-version catalogue: a legacy per-host record cannot authorize retired image members.
test('legacy-only uninstall keeps retired image members as unknown and removes current package members', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const legacy = await formatOneRecord(host);
  const currentMembers = legacy.files.filter((file) => file.root === 'brand');
  assert.ok(currentMembers.length > 0);
  const relative = 'lib/retired-legacy-member.mjs';
  const target = path.join(host.brandRoot, relative);
  const bytes = Buffer.from('retired package member\n');
  await fs.writeFile(target, bytes);
  legacy.files.push({ root: 'brand', path: relative });
  legacy.fingerprints.brand[relative] = contentFingerprint(bytes);
  await fs.mkdir(path.dirname(legacyInstallRecordPath(host)), { recursive: true });
  await fs.writeFile(legacyInstallRecordPath(host), `${JSON.stringify(legacy, null, 2)}\n`);
  await fs.unlink(installRecordPath(host));
  assert.ok((await readInstallRecord(host)).files.some((file) => file.path === relative));

  const dryRun = await uninstall({ host, dryRun: true });
  assert.equal(dryRun.exitCode, 0);
  assert.ok(dryRun.output.split('\n').includes(`Would leave brand/${relative} (unknown)`));
  assert.deepEqual(await fs.readFile(target), bytes);
  await fs.access(legacyInstallRecordPath(host));

  const result = await uninstall({ host });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.ok(result.output.split('\n').includes(`Left brand/${relative} (unknown)`));
  for (const member of currentMembers) {
    await assert.rejects(() => fs.access(recordTarget(host, member)), { code: 'ENOENT' });
  }
  await assert.rejects(() => fs.access(legacyInstallRecordPath(host)), { code: 'ENOENT' });
  assert.equal(dryRun.output.split('\n').at(-1), artifactsLine());
  assert.equal(result.output.split('\n').at(-1), artifactsLine());
});
