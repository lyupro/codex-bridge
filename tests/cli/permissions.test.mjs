/** Verifies permission rule generation, exact merging, removal, and uninstall cleanup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import {
  PERMISSION_RULES,
  permissions,
} from '../../cli/permissions.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { permissionsCheck } from '../../cli/doctor-installation.mjs';

async function fixture(t) {
  const root = makeTempTree('bridge-permissions-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
  await fs.mkdir(host.root, { recursive: true });
  return { root, host };
}

async function readSettings(host) {
  return JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
}

async function writeSettings(host, settings) {
  await fs.writeFile(host.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function ownEntries(list, rules) {
  return list.filter((entry) => rules.includes(entry));
}

const ALL_PERMISSION_RULES = Object.values(PERMISSION_RULES).flat();

async function backups(host) {
  return (await fs.readdir(host.root)).filter((name) =>
    name.startsWith('settings.json.codex-bridge-backup-'));
}

test('permissions add builds the complete matrix and preserves foreign settings', async (t) => {
  const { host } = await fixture(t);
  await writeSettings(host, {
    model: 'operator-model',
    permissions: {
      allow: ['Bash(foreign command)'],
      deny: ['PowerShell(foreign command)'],
      ask: ['Bash(foreign ask)'],
    },
  });
  const localSettings = path.join(host.root, 'settings.local.json');
  await fs.writeFile(localSettings, 'operator-local-settings');

  const result = await permissions({ host, action: 'add' });
  assert.equal(result.added, 36);
  assert.equal(result.present, ALL_PERMISSION_RULES.length);
  assert.equal(result.total, ALL_PERMISSION_RULES.length);
  assert.equal(PERMISSION_RULES.allow.length, 12);
  assert.equal(PERMISSION_RULES.deny.length, 12);
  assert.equal(PERMISSION_RULES.ask.length, 12);
  const expectedAsk = ['Bash', 'PowerShell'].flatMap((tool) =>
    ['codex-bridge', 'codexb', 'node bin/codex-bridge.mjs'].flatMap((command) =>
      [`${tool}(${command} model speed)`, `${tool}(${command} model speed:*)`]));
  assert.deepEqual(new Set(PERMISSION_RULES.ask), new Set(expectedAsk));
  assert.equal(result.askCount, 0);
  assert.equal(result.output, `Added 36 permission rule strings. ${(await permissions({ host })).output}`);
  assert.doesNotMatch(result.output, /outranks allow/);

  const settings = await readSettings(host);
  assert.equal(settings.model, 'operator-model');
  assert.deepEqual(ownEntries(settings.permissions.allow, PERMISSION_RULES.allow), PERMISSION_RULES.allow);
  assert.deepEqual(ownEntries(settings.permissions.deny, PERMISSION_RULES.deny), PERMISSION_RULES.deny);
  assert.deepEqual(ownEntries(settings.permissions.ask, PERMISSION_RULES.ask), PERMISSION_RULES.ask);
  assert.ok(settings.permissions.allow.includes('Bash(foreign command)'));
  assert.ok(settings.permissions.deny.includes('PowerShell(foreign command)'));
  assert.ok(settings.permissions.ask.includes('Bash(foreign ask)'));
  assert.equal(await fs.readFile(localSettings, 'utf8'), 'operator-local-settings');
});

test('repeated permissions add is idempotent and does not create another backup', async (t) => {
  const { host } = await fixture(t);
  await writeSettings(host, { permissions: { allow: [], deny: [] } });

  const first = await permissions({ host, action: 'add' });
  const before = await backups(host);
  const second = await permissions({ host, action: 'add' });
  const settings = await readSettings(host);

  assert.equal(first.added, 36);
  assert.equal(second.added, 0);
  assert.equal(first.present, ALL_PERMISSION_RULES.length);
  assert.equal(second.present, ALL_PERMISSION_RULES.length);
  assert.equal(second.total, ALL_PERMISSION_RULES.length);
  // The 2026-09-07, 0.6.0 install incident made an already complete set sound like a failed add.
  assert.equal(second.output, (await permissions({ host })).output);
  assert.match(second.output, /Permissions: installed \(36\/36 own strings in allow\/deny\/ask\)/);
  assert.doesNotMatch(second.output, /Added 0/);
  assert.deepEqual(await backups(host), before);
  for (const [name, rules] of Object.entries(PERMISSION_RULES)) {
    for (const rule of rules) {
      assert.equal(settings.permissions[name].filter((entry) => entry === rule).length, 1, rule);
    }
  }
});

test('permissions remove takes back exact strings from allow, deny, and ask only', async (t) => {
  const { host } = await fixture(t);
  await permissions({ host, action: 'add' });
  const settings = await readSettings(host);
  settings.permissions.ask.push('Bash(foreign ask)');
  const moved = settings.permissions.allow.shift();
  const lookalike = `${PERMISSION_RULES.allow[0]} `;
  settings.permissions.ask.push(moved);
  settings.permissions.allow.push(lookalike);
  settings.permissions.allow.push(settings.permissions.ask.shift());
  settings.permissions.deny.push(settings.permissions.ask.shift());
  await writeSettings(host, settings);

  const result = await permissions({ host, action: 'remove' });
  const remaining = await readSettings(host);
  assert.equal(result.removed, 36);
  for (const name of ['allow', 'deny', 'ask']) {
    assert.deepEqual(ownEntries(remaining.permissions[name], ALL_PERMISSION_RULES), []);
  }
  assert.ok(remaining.permissions.allow.includes(lookalike));
  assert.deepEqual(remaining.permissions.ask, ['Bash(foreign ask)']);
});

test('permissions without an action reports absent, partial, and installed states', async (t) => {
  const { host } = await fixture(t);
  await writeSettings(host, { permissions: { allow: [], deny: [] } });

  assert.match((await permissions({ host })).output, /Permissions: absent \(0\/36/);
  await permissions({ host, action: 'add' });
  const complete = await permissions({ host });
  assert.equal(complete.complete, true);
  assert.equal(complete.askCount, 0);
  assert.deepEqual(complete.counts, { allow: 12, deny: 12, ask: 12 });
  assert.match(complete.output, /Permissions: installed \(36\/36 own strings in allow\/deny\/ask\)/);
  const settings = await readSettings(host);
  settings.permissions.deny.pop();
  settings.permissions.ask.pop();
  await writeSettings(host, settings);
  const partial = await permissions({ host });
  assert.equal(partial.complete, false);
  assert.equal(partial.askCount, 0);
  assert.deepEqual(partial.counts, { allow: 12, deny: 11, ask: 11 });
  assert.match(partial.output, /Permissions: partially installed \(34\/36/);
  assert.doesNotMatch(partial.output, /shadowed/);
});

/**
 * `ask` outranks `allow`, so a string the operator moved there keeps the questions coming after a
 * seemingly complete `add`. The command must say so instead of reporting a set it cannot deliver.
 */
test('permissions add names its own strings left sitting in ask', async (t) => {
  const { host } = await fixture(t);
  await permissions({ host, action: 'add' });
  const settings = await readSettings(host);
  settings.permissions.ask.push(settings.permissions.allow.shift());
  await writeSettings(host, settings);

  const partial = await permissions({ host });
  assert.equal(partial.state, 'partially installed, shadowed by ask');
  assert.equal(partial.present, 35);
  assert.equal(partial.askCount, 1);
  assert.match(partial.output, /shadowed by ask \(35\/36 .*outranks allow/);

  const result = await permissions({ host, action: 'add' });

  assert.equal(result.added, 1);
  assert.equal(result.askCount, 1);
  assert.equal(result.output, 'Added 1 permission rule string. Permissions: shadowed by ask (36/36 own strings in allow/deny/ask).'
    + ' 1 own string(s) also sit in ask, which outranks allow; they were left there.');
  assert.match(result.output, /1 own string\(s\) also sit in ask, which outranks allow/);
  assert.deepEqual((await readSettings(host)).permissions.ask, settings.permissions.ask);
});

/**
 * The count alone said 24/24 while one string sat in `ask` and kept the question alive — doctor
 * called that healthy during the Plan_22-1 live run. A complete set is only complete when nothing
 * shadows it.
 */
test('a complete set shadowed by ask is not reported as installed', async (t) => {
  const { host } = await fixture(t);
  await permissions({ host, action: 'add' });
  const settings = await readSettings(host);
  settings.permissions.ask.push(settings.permissions.allow[0]);
  await writeSettings(host, settings);

  const status = await permissions({ host });

  assert.equal(status.present, 36);
  assert.equal(status.complete, true);
  assert.equal(status.state, 'shadowed by ask');
  assert.match(status.output, /shadowed by ask \(36\/36 .*outranks allow/);
});

test('permissions without an action writes nothing at all', async (t) => {
  const { host } = await fixture(t);
  await permissions({ host, action: 'add' });
  const before = await fs.readFile(host.settingsPath, 'utf8');
  const beforeBackups = await backups(host);

  await permissions({ host });

  assert.equal(await fs.readFile(host.settingsPath, 'utf8'), before);
  assert.deepEqual(await backups(host), beforeBackups);
});

test('uninstall removes permission strings even without an installation record', async (t) => {
  const { host } = await fixture(t);
  await writeSettings(host, {
    permissions: { allow: ['Bash(foreign command)'], deny: [], ask: [] },
  });
  await permissions({ host, action: 'add' });

  const result = await uninstall({ host });
  const settings = await readSettings(host);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Removed 36 permission rule strings/);
  assert.match(result.output, /not installed/);
  assert.deepEqual(ownEntries(settings.permissions.allow, ALL_PERMISSION_RULES), []);
  assert.deepEqual(ownEntries(settings.permissions.deny, ALL_PERMISSION_RULES), []);
  assert.deepEqual(ownEntries(settings.permissions.ask, ALL_PERMISSION_RULES), []);
  assert.ok(settings.permissions.allow.includes('Bash(foreign command)'));
});

test('uninstall dry-run counts permission strings without writing settings', async (t) => {
  const { host } = await fixture(t);
  await permissions({ host, action: 'add' });
  const before = await fs.readFile(host.settingsPath, 'utf8');
  const beforeBackups = await backups(host);

  const result = await uninstall({ host, dryRun: true });

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Would remove 36 permission rule strings/);
  assert.equal(await fs.readFile(host.settingsPath, 'utf8'), before);
  assert.deepEqual(await backups(host), beforeBackups);
});

test('a deny string copied into ask does not shadow the allow set', async (t) => {
  const { host } = await fixture(t);
  await permissions({ host, action: 'add' });
  const settings = await readSettings(host);
  settings.permissions.ask.push(PERMISSION_RULES.deny[0]);
  await writeSettings(host, settings);
  const status = await permissions({ host });
  assert.equal(status.state, 'installed');
  assert.equal(status.askCount, 0);
  assert.equal(status.present, 36);
});

test('an older allow/deny installation is partial until speed ask rules are installed', async (t) => {
  const { host } = await fixture(t);
  await writeSettings(host, { permissions: {
    allow: [...PERMISSION_RULES.allow], deny: [...PERMISSION_RULES.deny],
  } });
  const before = await permissions({ host });
  assert.equal(before.state, 'partially installed');
  assert.equal(before.present, 24);
  assert.equal(before.total, 36);
  assert.equal((await permissions({ host, action: 'add' })).added, 12);
  assert.equal((await permissions({ host })).state, 'installed');
});

// Plan_56: doctor must name all three lists its count includes, even when an allow is shadowed.
for (const [scenario, edit, state, level, present, shadow] of [
  ['complete', () => {}, 'installed', 'ok', 36, ''],
  ['partial', (rules) => rules.ask.pop(), 'partially installed', 'warn', 35, ''],
  ['shadowed', (rules) => rules.ask.push(rules.allow[0]), 'shadowed by ask', 'warn', 36, ', 1 shadowed by ask'],
  ['moved allow', (rules) => rules.ask.push(rules.allow.shift()),
    'partially installed, shadowed by ask', 'warn', 35, ', 1 shadowed by ask'],
]) {
  test(`doctor reports truthful permission counts and list names for a ${scenario} set`, async (t) => {
    const { host } = await fixture(t);
    await permissions({ host, action: 'add' });
    const settings = await readSettings(host);
    edit(settings.permissions);
    await writeSettings(host, settings);
    const result = await permissionsCheck(host);
    assert.equal(result.status, level);
    assert.equal(result.value, `${state} (${present}/36 own strings in allow/deny/ask${shadow})`);
  });
}
