/** Guards Plan_65 D12: gather a complete, read-only removal plan without losing edits or links. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../../cli/install.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { buildHomeRemovalPlan } from '../../cli/home-removal-plan.mjs';
import {
  imageMembers, installRecordPath, readInstallRecord, readInstallRecordFile,
} from '../../cli/install-record.mjs';
import { contentFingerprint } from '../../cli/manifest.mjs';
import { validateFormat2 } from '../../cli/install-owners.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const commands = ['uninstall', 'purge'];
const rowAt = (plan, relative) => plan.rows.find((row) => row.relative === relative);
const imageRows = (plan) => plan.rows.filter((row) => row.id === 'install-image' && row.role === 'primary');
const removePolicy = (command) => ({ remove: true, reason: command === 'purge' ? 'purge' : 'last owner' });

async function installedHome(t) {
  const root = makeTempTree('bridge-home-removal-plan-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'home'),
  });
  await install({ host });
  const record = await readInstallRecordFile(host);
  const members = imageMembers(record, host).filter((file) => file.root === 'brand');
  return { root, host, record, members };
}

async function snapshot(root) {
  const entries = [];
  const walk = async (relative) => {
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      entries.push({ relative, kind: 'link', target: await fs.readlink(absolute) });
    } else if (stat.isDirectory()) {
      entries.push({ relative, kind: 'directory' });
      for (const name of (await fs.readdir(absolute)).sort()) {
        await walk(relative ? `${relative}/${name}` : name);
      }
    } else {
      entries.push({ relative, kind: 'file', bytes: await fs.readFile(absolute) });
    }
  };
  await walk('');
  return entries;
}

for (const command of commands) {
  test(`fresh ${command} uses recorded evidence and the caller's removal policy`, async (t) => {
    const { host, record, members } = await installedHome(t);
    const imagePolicy = Object.freeze(removePolicy(command));
    const plan = await buildHomeRemovalPlan({ command, host, packageRoot, imagePolicy });
    assert.equal(plan.recordState, 'valid');
    assert.equal(plan.homeRoot, 'present');
    assert.deepEqual(plan.format2, record);
    assert.equal(imageRows(plan).length, members.length);
    assert.ok(imageRows(plan).length > 0);
    for (const row of imageRows(plan)) {
      assert.equal(row.action, 'remove');
      assert.equal(row.reason, 'evidence: recorded');
    }
    for (const relative of ['config.json', 'conventions.md']) {
      assert.equal(rowAt(plan, relative).action, command === 'purge' ? 'remove' : 'keep');
      assert.equal(rowAt(plan, relative).reason, command === 'purge' ? 'purge' : 'purge-only');
    }
    assert.equal(plan.record.operation, 'delete');
    assert.equal(plan.record.dependsOnDetach, true);
    assert.equal(plan.blocked, false);
    assert.deepEqual(imagePolicy, removePolicy(command));
    const relatives = plan.rows.map((row) => row.relative);
    assert.deepEqual(relatives, [...new Set(relatives)].sort());
  });

  test(`${command} preserves an edited image file`, async (t) => {
    const { host, members } = await installedHome(t);
    const relative = members[0].path;
    await fs.appendFile(path.join(host.brandRoot, relative), '\noperator edit\n');
    const plan = await buildHomeRemovalPlan({ command, host, packageRoot, imagePolicy: removePolicy(command) });
    assert.equal(rowAt(plan, relative).action, 'keep');
    assert.equal(rowAt(plan, relative).reason, 'changed');
    assert.equal(plan.blocked, false);
  });

  test(`${command} retains a corrupt JSON record and blocks removal`, async (t) => {
    const { host } = await installedHome(t);
    await fs.writeFile(installRecordPath(host), '{');
    const plan = await buildHomeRemovalPlan({ command, host, packageRoot, imagePolicy: removePolicy(command) });
    assert.equal(plan.recordState, 'corrupt');
    assert.equal(plan.format2, undefined);
    assert.equal(plan.record.operation, 'retain');
    assert.equal(plan.blocked, true);
    assert.ok(imageRows(plan).length > 0);
    for (const row of imageRows(plan)) {
      assert.equal(row.reason, 'evidence: package');
    }
  });

  test(`${command} rejects a parsed record that fails format-2 validation`, async (t) => {
    const { host, record } = await installedHome(t);
    record.inventory = 'invalid';
    await fs.writeFile(installRecordPath(host), JSON.stringify(record));
    const plan = await buildHomeRemovalPlan({ command, host, packageRoot, imagePolicy: removePolicy(command) });
    assert.equal(plan.recordState, 'corrupt');
    assert.equal(plan.format2, undefined);
    assert.equal(plan.record.operation, 'retain');
    assert.equal(plan.blocked, true);
    assert.ok(imageRows(plan).length > 0);
    for (const row of imageRows(plan)) {
      assert.equal(row.reason, 'evidence: package');
    }
  });

  test(`${command} finds package image members when the record is missing`, async (t) => {
    const { host, members } = await installedHome(t);
    await fs.unlink(installRecordPath(host));
    const plan = await buildHomeRemovalPlan({ command, host, packageRoot, imagePolicy: removePolicy(command) });
    assert.equal(plan.recordState, 'missing');
    assert.equal(plan.format2, undefined);
    assert.equal(plan.record.operation, 'none');
    assert.equal(plan.blocked, false);
    assert.equal(imageRows(plan).length, members.length);
    for (const row of imageRows(plan)) {
      assert.equal(row.action, 'remove');
      assert.equal(row.reason, 'evidence: package');
    }
  });

  test(`${command} blocks files hidden behind a junction and leaves outside bytes unchanged`, async (t) => {
    const { root, host, members } = await installedHome(t);
    const relativeFolder = 'lib/runner';
    const movedFiles = members.filter((file) => file.path.startsWith(`${relativeFolder}/`));
    assert.ok(movedFiles.length > 0);
    const folder = path.join(host.brandRoot, relativeFolder);
    const outside = path.join(root, 'outside-runner');
    await fs.rename(folder, outside);
    await fs.symlink(outside, folder, 'junction');
    const before = await snapshot(root);
    const plan = await buildHomeRemovalPlan({ command, host, packageRoot, imagePolicy: removePolicy(command) });
    assert.equal(rowAt(plan, relativeFolder).action, 'blocked');
    assert.equal(rowAt(plan, relativeFolder).reason, 'link');
    for (const file of movedFiles) {
      assert.equal(rowAt(plan, file.path).action, 'blocked');
      assert.equal(rowAt(plan, file.path).reason, `link at ${relativeFolder}`);
    }
    assert.equal(plan.blocked, true);
    assert.deepEqual(await snapshot(root), before);
  });

  test(`${command} leaves the whole installation tree byte-for-byte unchanged`, async (t) => {
    const { root, host } = await installedHome(t);
    await fs.writeFile(path.join(host.brandRoot, 'operator-notes.txt'), 'keep these bytes\n');
    const before = await snapshot(root);
    const first = await buildHomeRemovalPlan({ command, host, packageRoot, imagePolicy: removePolicy(command) });
    const second = await buildHomeRemovalPlan({ command, host, packageRoot, imagePolicy: removePolicy(command) });
    assert.deepEqual(second, first);
    assert.deepEqual(await snapshot(root), before);
  });
}

test('uninstall preserves image files and removes only the normalized current owner', async (t) => {
  const { host, record, members } = await installedHome(t);
  const imagePolicy = Object.freeze({ remove: false, reason: 'other-owners' });
  const plan = await buildHomeRemovalPlan({ command: 'uninstall', host, packageRoot, imagePolicy });
  assert.equal(imageRows(plan).length, members.length);
  for (const row of imageRows(plan)) {
    assert.equal(row.action, 'keep');
    assert.equal(row.reason, 'other-owners');
  }
  assert.equal(plan.record.operation, 'remove-current-owner');
  assert.equal(plan.record.reason, 'other-owners');
  assert.equal(plan.record.dependsOnDetach, true);
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.format2, record);
  assert.deepEqual(imagePolicy, { remove: false, reason: 'other-owners' });
});

test('an unreadable record path is corrupt rather than missing', async (t) => {
  const { host } = await installedHome(t);
  const recordPath = installRecordPath(host);
  await fs.rename(recordPath, `${recordPath}.saved`);
  await fs.mkdir(recordPath);
  const plan = await buildHomeRemovalPlan({
    command: 'uninstall', host, packageRoot, imagePolicy: removePolicy('uninstall'),
  });
  assert.equal(plan.recordState, 'corrupt');
  assert.equal(plan.format2, undefined);
  assert.equal(plan.record.operation, 'retain');
  assert.equal(plan.blocked, true);
});

test('format-1 migration builds a valid format-2 plan without rewriting the record', async (t) => {
  const { root, host } = await installedHome(t);
  const legacy = await readInstallRecord(host);
  await fs.writeFile(installRecordPath(host), JSON.stringify(legacy));
  const before = await snapshot(root);
  const plan = await buildHomeRemovalPlan({
    command: 'uninstall', host, packageRoot, imagePolicy: removePolicy('uninstall'),
  });
  assert.equal(plan.recordState, 'valid');
  assert.equal(plan.format2.format, 2);
  assert.equal(plan.record.operation, 'delete');
  assert.equal(plan.blocked, false);
  assert.deepEqual(await snapshot(root), before);
});

test('D12 includes recorded-only and package-only members once in sorted order', async (t) => {
  const { host, record, members } = await installedHome(t);
  // D12's union fixture drops an image member, keeping the record's required hooks intact.
  const packageOnly = members.find((file) => file.path.startsWith('lib/runner/')).path;
  record.image.files = record.image.files.filter((file) => file.path !== packageOnly);
  delete record.image.fingerprints.brand[packageOnly];
  const recordedOnly = 'lib/retired-removal-member.mjs';
  const bytes = Buffer.from('retired package member\n');
  await fs.writeFile(path.join(host.brandRoot, recordedOnly), bytes);
  record.image.files.push({ root: 'brand', path: recordedOnly });
  record.image.fingerprints.brand[recordedOnly] = contentFingerprint(bytes);
  assert.doesNotThrow(() => validateFormat2(record));
  await fs.writeFile(installRecordPath(host), JSON.stringify(record));
  const plan = await buildHomeRemovalPlan({
    command: 'uninstall', host, packageRoot, imagePolicy: removePolicy('uninstall'),
  });
  assert.equal(plan.recordState, 'valid');
  assert.equal(rowAt(plan, recordedOnly).action, 'remove');
  assert.equal(rowAt(plan, recordedOnly).reason, 'evidence: recorded');
  assert.equal(rowAt(plan, packageOnly).action, 'remove');
  assert.equal(rowAt(plan, packageOnly).reason, 'evidence: package');
  assert.equal(imageRows(plan).length, members.length + 1);
  const expectedMembers = [...new Set([...members.map((file) => file.path), recordedOnly])].sort();
  assert.deepEqual(plan.imageMembers, expectedMembers);
  const relatives = plan.rows.map((row) => row.relative);
  assert.deepEqual(relatives, [...new Set(relatives)].sort());
});

test('a home that has never been installed reports its missing root', async (t) => {
  const root = makeTempTree('bridge-home-removal-missing-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'), codexHome: path.join(root, 'codex-home'), brandRoot: path.join(root, 'missing'),
  });
  const plan = await buildHomeRemovalPlan({ command: 'purge', host, packageRoot, imagePolicy: removePolicy('purge') });
  assert.equal(plan.homeRoot, 'missing');
  assert.equal(plan.recordState, 'missing');
  await assert.rejects(fs.lstat(host.brandRoot), { code: 'ENOENT' });
});
