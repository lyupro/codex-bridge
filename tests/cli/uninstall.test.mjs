/** Verifies exact uninstall: recorded files and hooks go, host data and foreign entries stay. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { HOOK_DEFINITIONS, readInstallRecord } from '../../cli/manifest.mjs';
import {
  readRulesRegistry,
  remainingRulesOwners,
  rulesRegistryPath,
} from '../../cli/rules-owners.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { normalizeRepoPath } from '../../src/runner/project-dir.mjs';
import { allFiles, fixture } from './host-fixture.mjs';

test('a missing registry is distinct from an empty owner list', () => {
  assert.equal(remainingRulesOwners(null, { root: String.raw`C:\Repos\Current` }), null);
});

test('a sole owner leaves no owners remaining', () => {
  const host = { root: String.raw`C:\Repos\Current` };
  assert.deepEqual(remainingRulesOwners({ version: 1, owners: ['c:/repos/current'] }, host), []);
});

test('other owners remain when the current path differs in case and slashes', () => {
  const host = { root: String.raw`C:\Repos\Current` };
  const otherOwners = ['c:/repos/other', 'd:/repos/shared'];
  assert.deepEqual(
    remainingRulesOwners({
      version: 1,
      owners: ['c:/repos/other', 'c:/repos/current', 'd:/repos/shared'],
    }, host),
    otherOwners,
  );
});

test('uninstall leaves shared rules for another owner and removes them for the last owner', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-shared-owners-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'codex-home');
  const first = resolveHost({ host: path.join(root, 'first-host'), codexHome });
  const second = resolveHost({ host: path.join(root, 'second-host'), codexHome });
  await install({ host: first });
  await install({ host: second });
  const rulesPath = path.join(codexHome, 'rules', 'codex-bridge.rules');
  assert.equal((await readRulesRegistry(first)).owners.length, 2);

  const removedFirst = await uninstall({ host: first });
  assert.match(removedFirst.output, /1 other owner remains/);
  await fs.access(rulesPath);
  assert.deepEqual(await readRulesRegistry(second), {
    version: 1,
    owners: [normalizeRepoPath(second.root)],
  });

  const dryRun = await uninstall({ host: second, dryRun: true });
  assert.match(dryRun.output, /Would remove .*codex-bridge\.rules/);
  await fs.access(rulesPath);
  assert.equal((await uninstall({ host: second })).exitCode, 0);
  await assert.rejects(() => fs.access(rulesPath), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(rulesRegistryPath(second)), { code: 'ENOENT' });
});

// Four of the five hooks are PreToolUse, so a lookup by event alone names the order gate for all
// of them. The live dry-run of 2026-08-09 announced matcher Agent|Task for the worktree lock and
// the prune guard — the one line an operator reads to see what a removal will touch.
test('dry-run uninstall names each hook by its own matcher', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const dryRun = await uninstall({ host, dryRun: true });
  for (const definition of HOOK_DEFINITIONS) {
    const line = `Would remove the ${definition.event} hook for matcher ${definition.matcher}.`;
    assert.equal(
      dryRun.output.split('\n').filter((entry) => entry === line).length,
      1,
      `expected exactly one line for ${definition.file}`,
    );
  }
});

test('uninstall removes only recorded files and hook while preserving foreign hook, files, and runs', async (t) => {
  const { host } = await fixture(t);
  await fs.mkdir(host.root, { recursive: true });
  await fs.writeFile(host.settingsPath, JSON.stringify({
    hooks: {
      SubagentStop: [{ matcher: '*', hooks: [{ type: 'command', command: 'dacapo hook claude' }] }],
      PreToolUse: [{ matcher: 'Agent', hooks: [{ type: 'command', command: 'foreign pre-tool hook' }] }],
    },
  }));
  await install({ host });
  const foreign = path.join(host.agentsDir, 'foreign.txt');
  const run = path.join(host.root, 'codex-runs', 'run.json');
  await fs.writeFile(foreign, 'keep');
  await fs.mkdir(path.dirname(run), { recursive: true });
  await fs.writeFile(run, 'keep');
  const result = await uninstall({ host });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /artifacts.*preserved/i);
  assert.equal(await fs.readFile(foreign, 'utf8'), 'keep');
  assert.equal(await fs.readFile(run, 'utf8'), 'keep');
  assert.equal(await readInstallRecord(host), null);
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  assert.deepEqual(settings.hooks.SubagentStop[0].hooks, [{ type: 'command', command: 'dacapo hook claude' }]);
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks, [{ type: 'command', command: 'foreign pre-tool hook' }]);
  const remainingBridgeHooks = settings.hooks.PreToolUse.flatMap(({ hooks }) => hooks)
    .filter(({ command }) => /order-gate|worktree-lock/.test(command));
  assert.deepEqual(remainingBridgeHooks, []);
  await assert.rejects(() => fs.access(host.commandsDir), { code: 'ENOENT' });
});

test('uninstall removes unchanged bridge rules but preserves adjacent Codex rules', async (t) => {
  const { host } = await fixture(t);
  const defaultRules = path.join(host.codexRulesDir, 'default.rules');
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  await fs.writeFile(defaultRules, 'operator rules');
  await install({ host });
  const bridgeRules = (await readInstallRecord(host)).rules.path;
  assert.equal((await uninstall({ host })).exitCode, 0);
  await assert.rejects(() => fs.access(bridgeRules), { code: 'ENOENT' });
  assert.equal(await fs.readFile(defaultRules, 'utf8'), 'operator rules');
  assert.deepEqual(await fs.readdir(host.codexRulesDir), ['default.rules']);
});

test('uninstall preserves a manually changed rules file and explains why', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const rulesPath = (await readInstallRecord(host)).rules.path;
  await fs.writeFile(rulesPath, 'operator change');
  const result = await uninstall({ host });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Left .*codex-bridge\.rules.*contents changed/);
  assert.equal(await fs.readFile(rulesPath, 'utf8'), 'operator change');
});

test('uninstall accepts a legacy record without rules metadata', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const recordPath = path.join(host.agentsDir, '.codex-bridge-install.json');
  const legacy = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  const rulesPath = legacy.rules.path;
  delete legacy.rules;
  await fs.writeFile(recordPath, `${JSON.stringify(legacy, null, 2)}\n`);
  assert.equal((await uninstall({ host })).exitCode, 0);
  assert.equal(await fs.readFile(rulesPath, 'utf8'), await fs.readFile('src/rules/codex-bridge.rules', 'utf8'));
});

test('uninstall without an ownership registry uses the legacy fingerprint behavior', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const record = await readInstallRecord(host);
  await fs.rm(rulesRegistryPath(host));
  const result = await uninstall({ host });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /ownership registry was missing.*other installations may use/i);
  await assert.rejects(() => fs.access(record.rules.path), { code: 'ENOENT' });
});

test('uninstall completes with a corrupt registry and preserves shared rules', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const record = await readInstallRecord(host);
  await fs.writeFile(rulesRegistryPath(host), '{"version":1,"owners":[');

  const result = await uninstall({ host });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Left .*rules ownership registry is invalid.*ownership is unknown/i);
  assert.deepEqual(await fs.readFile(record.rules.path), await fs.readFile('src/rules/codex-bridge.rules'));
  for (const relative of record.files) {
    await assert.rejects(() => fs.access(path.join(host.root, relative)), { code: 'ENOENT' });
  }
  await assert.rejects(() => fs.access(path.join(host.agentsDir, '.codex-bridge-install.json')), { code: 'ENOENT' });
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  assert.deepEqual(settings.hooks.SubagentStop, []);
  assert.deepEqual(settings.hooks.PreToolUse, []);
});

test('uninstall without a record is nonzero and dry-run uninstall changes nothing', async (t) => {
  const absent = await fixture(t);
  const missing = await uninstall({ host: absent.host });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.output, /not installed/);
  await assert.rejects(() => fs.access(absent.host.root), { code: 'ENOENT' });

  const installed = await fixture(t);
  await install({ host: installed.host });
  const before = await allFiles(installed.host.root);
  const dry = await uninstall({ host: installed.host, dryRun: true });
  assert.equal(dry.exitCode, 0);
  assert.match(dry.output, /Would remove/);
  assert.deepEqual(await allFiles(installed.host.root), before);
  assert.equal((await uninstall({ host: installed.host })).exitCode, 0);
  // The agents directory outlives an uninstall by exactly one file: the config the operator
  // owns. Everything the package put there is gone, and the commands directory with it.
  assert.deepEqual((await fs.readdir(installed.host.agentsDir)).sort(), ['conventions.md', 'run-config.json']);
  await assert.rejects(() => fs.access(installed.host.commandsDir), { code: 'ENOENT' });
});
