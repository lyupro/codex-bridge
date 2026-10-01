/** Guards Plan_65 B20b: preflight precedes mutation, and purge requires a detached host. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../../cli/install.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { permissions } from '../../cli/permissions.mjs';
import { findOwnHooks } from '../../cli/hook-recognizer.mjs';
import { installRecordPath, readInstallRecord, recordTarget } from '../../cli/manifest.mjs';
import { purge, appearedLines } from '../../cli/uninstall-purge.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { commandOptions, COMMANDS } from '../../cli/command-registry.mjs';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const clear = () => ({ verdict: 'clear', blocked: [], unknown: [] });
const blocked = () => ({ verdict: 'blocked', blocked: [{ runDir: 'live', stop: 'stop live' }], unknown: [] });

async function installedHome(t) {
  const root = makeTempTree('bridge-uninstall-purge-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'), codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'home'),
  });
  assert.equal((await install({ host })).exitCode, 0);
  assert.equal((await permissions({ host, action: 'add' })).exitCode, 0);
  return { root, host };
}

function consent(answers = ['yes', 'yes'], extra = {}) {
  const questions = [];
  const options = { isTTY: true, ...extra, prompt: async (question) => {
    questions.push(question);
    assert.ok(questions.length <= answers.length, 'No unexpected consent question');
    return answers[questions.length - 1];
  } };
  return { options, questions };
}

async function snapshot(root) {
  const entries = [];
  const walk = async (relative) => {
    const target = path.join(root, relative);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) {
      entries.push({ relative, kind: 'link', target: await fs.readlink(target) });
    } else if (stat.isDirectory()) {
      entries.push({ relative, kind: 'directory' });
      for (const name of (await fs.readdir(target)).sort()) {
        await walk(relative ? `${relative}/${name}` : name);
      }
    } else {
      entries.push({ relative, kind: 'file', bytes: await fs.readFile(target) });
    }
  };
  await walk('');
  return entries;
}

async function unchanged(host) {
  const before = {
    settings: await fs.readFile(host.settingsPath),
    agents: await snapshot(host.agentsDir), home: await snapshot(host.brandRoot),
  };
  return async () => {
    assert.deepEqual(await fs.readFile(host.settingsPath), before.settings);
    assert.deepEqual(await snapshot(host.agentsDir), before.agents);
    assert.deepEqual(await snapshot(host.brandRoot), before.home);
  };
}

for (const verdict of ['blocked', 'unknown']) {
  test(`${verdict} live runs refuse before consent or any mutation`, async (t) => {
    const { host } = await installedHome(t);
    // D14: the live-run refusal must precede even a broken installation inventory.
    await fs.writeFile(installRecordPath(host), '{');
    const verifyUnchanged = await unchanged(host);
    const { options, questions } = consent();
    let checks = 0;
    const result = await purge({ host, packageRoot, ...options, liveRunCheck: () => {
      checks += 1;
      return verdict === 'blocked' ? blocked()
        : { verdict, blocked: [], unknown: [{ path: 'runs', reason: 'EACCES' }] };
    } });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /^Purge refused; nothing was changed\./);
    assert.doesNotMatch(result.output, /installation record/);
    assert.equal(checks, 1);
    assert.equal(questions.length, 0);
    await verifyUnchanged();
  });
}

test('another recorded owner refuses, names it and never asks consent', async (t) => {
  const { root, host } = await installedHome(t);
  const other = resolveHost({
    host: path.join(root, 'other-host'), codexHome: path.join(root, 'other-codex-home'), brandRoot: host.brandRoot,
  });
  await install({ host: other });
  const verifyUnchanged = await unchanged(host);
  const { options, questions } = consent();
  const result = await purge({ host, packageRoot, ...options, liveRunCheck: clear });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^Purge refused/);
  assert.ok(result.output.includes(`${normalizeRepoPath(other.root)} is recorded as using`));
  assert.equal(questions.length, 0);
  await verifyUnchanged();
});

test('corrupt record refuses without throwing, asking or changing anything', async (t) => {
  const { host } = await installedHome(t);
  await fs.writeFile(installRecordPath(host), '{');
  const verifyUnchanged = await unchanged(host);
  const { options, questions } = consent();
  const result = await purge({ host, packageRoot, ...options, liveRunCheck: clear });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^Purge refused/);
  assert.match(result.output, /installation record .* is unreadable/);
  assert.equal(questions.length, 0);
  await verifyUnchanged();
});

const refusals = [
  { name: 'inventory no', answers: ['no'], exitCode: 1, calls: 1 },
  { name: 'data no', answers: ['yes', 'no'], exitCode: 1, calls: 2 },
  { name: 'no terminal', answers: ['yes', 'yes'], exitCode: 1, calls: 0, extra: { isTTY: false } },
  { name: 'inventory cancel', answers: ['cancel'], exitCode: 130, calls: 1 },
  { name: 'data cancel', answers: ['yes', 'cancel'], exitCode: 130, calls: 2 },
];
for (const scenario of refusals) {
  test(`${scenario.name} leaves settings bytes, agents and home unchanged`, async (t) => {
    const { host } = await installedHome(t);
    const verifyUnchanged = await unchanged(host);
    const { options, questions } = consent(scenario.answers, scenario.extra);
    const result = await purge({ host, packageRoot, ...options, liveRunCheck: clear });
    assert.equal(result.exitCode, scenario.exitCode);
    assert.match(result.output, scenario.exitCode === 130
      ? /^Cancelled; nothing was changed\.$/ : /^Purge refused; nothing was changed\./);
    assert.equal(questions.length, scenario.calls);
    if (questions.length) assert.match(questions[0], /Is the inventory complete/);
    if (questions.length === 2) assert.match(questions[1], /Delete it\?/);
    await verifyUnchanged();
  });
}

test('both consents remove permissions, hooks, package agents, rules and the whole home', async (t) => {
  const { host } = await installedHome(t);
  const record = await readInstallRecord(host);
  const agents = record.files.filter((file) => recordTarget(host, file).startsWith(`${host.agentsDir}${path.sep}`));
  assert.ok(agents.length > 0);
  const settingsBefore = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  assert.ok(settingsBefore.permissions.allow.length > 0);
  assert.ok(findOwnHooks(settingsBefore, host).length > 0);
  for (const name of ['config.json', 'conventions.md']) await fs.access(path.join(host.brandRoot, name));
  const { options, questions } = consent();
  let checks = 0;
  const result = await purge({ host, packageRoot, ...options, liveRunCheck: () => {
    checks += 1;
    return clear();
  } });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /^Purged codex-bridge\./);
  assert.doesNotMatch(result.output, /Appeared during purge/);
  assert.equal(questions.length, 2);
  assert.equal(checks, 1, 'D14 permits exactly one preflight live-run check');
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  assert.equal(findOwnHooks(settings, host).length, 0);
  assert.deepEqual(settings.permissions.allow ?? [], []);
  for (const file of agents) await assert.rejects(fs.access(recordTarget(host, file)), { code: 'ENOENT' });
  await assert.rejects(fs.access(record.rules.path), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(host.brandRoot), { code: 'ENOENT' });
});

test('failed host detachment leaves the whole home untouched despite both consents', async (t) => {
  const { host } = await installedHome(t);
  const invalidSettings = Buffer.from('{"hooks":[', 'utf8');
  await fs.writeFile(host.settingsPath, invalidSettings);
  const verifyUnchanged = await unchanged(host);
  const { options, questions } = consent();
  const result = await purge({ host, packageRoot, ...options, liveRunCheck: clear });
  assert.equal(result.exitCode, 1);
  assert.equal(questions.length, 2);
  assert.match(result.output, /^Did not finish uninstalling codex-bridge:/);
  assert.ok(result.output.includes(
    `Left ${host.brandRoot} untouched: purge removes the home only after this host's hooks are gone.`));
  assert.doesNotMatch(result.output, /Purged codex-bridge\./);
  await verifyUnchanged();
});

test('missing home follows ordinary uninstall and appends the nothing-to-purge line', async (t) => {
  const { root, host } = await installedHome(t);
  await fs.rename(host.brandRoot, path.join(root, 'saved-home'));
  const { options, questions } = consent();
  const result = await purge({ host, ...options, liveRunCheck: () => assert.fail('No home means no preflight') });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /^Uninstalled codex-bridge\./);
  assert.ok(result.output.endsWith(`Nothing to purge: ${host.brandRoot} does not exist.`));
  assert.equal(questions.length, 0);
  assert.equal(findOwnHooks(JSON.parse(await fs.readFile(host.settingsPath, 'utf8')), host).length, 0);
  assert.equal(fsSync.existsSync(host.brandRoot), false);
  const ordinary = await uninstall({ host });
  const repeat = await purge({ host });
  assert.equal(repeat.exitCode, ordinary.exitCode);
  assert.equal(repeat.output, `${ordinary.output}\nNothing to purge: ${host.brandRoot} does not exist.`);
});

test('home missing at lifecycle entry never passes an undefined ticket to preflight', async (t) => {
  const { root, host } = await installedHome(t);
  await fs.rename(host.brandRoot, path.join(root, 'saved-home'));
  const existsSync = fsSync.existsSync;
  let homeChecks = 0;
  t.mock.method(fsSync, 'existsSync', (target) => {
    if (target === host.brandRoot) {
      homeChecks += 1;
      if (homeChecks === 1) return true;
    }
    return existsSync(target);
  });
  const result = await purge({ host, liveRunCheck: () => assert.fail('Missing home cannot reach preflight') });
  assert.equal(result.exitCode, 0);
  assert.ok(homeChecks >= 2);
  assert.ok(result.output.endsWith(`Nothing to purge: ${host.brandRoot} does not exist.`));
});

for (const scenario of ['clear', 'blocked', 'corrupt', 'attached']) {
  test(`dry run with ${scenario} diagnosis never prompts, locks or changes disk`, async (t) => {
    const { root, host } = await installedHome(t);
    if (scenario === 'corrupt') await fs.writeFile(installRecordPath(host), '{');
    if (scenario === 'attached') await fs.writeFile(host.settingsPath, '{"hooks":[');
    const before = await snapshot(root);
    let questions = 0;
    let checks = 0;
    const result = await purge({ host, packageRoot, dryRun: true, isTTY: true,
      prompt: () => { questions += 1; assert.fail('Dry run must never prompt'); },
      liveRunCheck: () => { checks += 1; return scenario === 'blocked' ? blocked() : clear(); },
    });
    assert.equal(result.exitCode, scenario === 'clear' ? 0 : 1);
    assert.equal(questions, 0);
    assert.equal(checks, 1);
    assert.match(result.output, /If you confirm both questions:/);
    if (scenario === 'blocked' || scenario === 'corrupt') {
      assert.match(result.output, /A real purge would refuse:/);
    }
    if (scenario === 'attached') assert.ok(result.output.includes(
      `Would leave ${host.brandRoot} untouched: this host's hooks could not be removed.`));
    const after = await snapshot(root);
    assert.deepEqual(after, before);
    assert.equal(after.some((entry) => /\.installed\.json\.lock[^/]*$/.test(entry.relative)), false);
  });
}

test('uninstall parses purge and dry-run as booleans and advertises both flags', () => {
  assert.deepEqual(commandOptions('uninstall', ['--purge', '--dry-run']), { purge: true, dryRun: true });
  assert.deepEqual(commandOptions('uninstall', ['--dry-run']), { dryRun: true });
  assert.deepEqual(COMMANDS.find((command) => command.name === 'uninstall').usage, [
    'codex-bridge uninstall [--scope user|project] [--host <path>] [--dry-run] [--purge]',
  ]);
  assert.throws(() => commandOptions('install', ['--purge']), /unknown install option/);
});

test('D12 item 7: the re-check names a registry file present after purge unless an outcome kept it', async (t) => {
  const root = makeTempTree('bridge-purge-recheck-');
  t.after(() => removeTempTree(root));
  const host = { brandRoot: path.join(root, 'home') };
  const plan = { imageMembers: [] };
  assert.deepEqual(appearedLines(host, plan, []), []);
  await fs.mkdir(host.brandRoot);
  await fs.writeFile(path.join(host.brandRoot, 'config.json'), '{}');
  await fs.writeFile(path.join(host.brandRoot, 'stranger.txt'), 'not ours');
  const appeared = appearedLines(host, plan, []);
  assert.equal(appeared.length, 1, 'only registry files count; unknown entries were never purge targets');
  assert.match(appeared[0], /^Appeared during purge: brand\/config\.json;/);
  const removed = [{ kind: 'file', relative: 'config.json', result: 'removed' }];
  assert.equal(appearedLines(host, plan, removed).length, 1, 'removed, then recreated');
  for (const result of ['kept', 'blocked', 'failed']) {
    assert.deepEqual(appearedLines(host, plan, [{ kind: 'file', relative: 'config.json', result }]), []);
  }
});
