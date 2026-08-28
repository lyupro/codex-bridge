/** Verifies doctor decisions for absent, complete, and damaged installations. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { diagnose, renderDoctor } from '../../cli/doctor.mjs';
import { install } from '../../cli/install.mjs';
import { HOOK_DEFINITIONS, recordTarget } from '../../cli/manifest.mjs';
import { addPermissionRules } from '../../cli/permissions.mjs';
import { PROJECT_MARKER } from '../../src/home/lib/runner/project-dir.mjs';
import { projectFolder } from '../../src/home/lib/write-meta.mjs';
import { codexProbe, hostFixture, installedFixture, ownPackage, runsRootFixture } from './doctor-fixtures.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function currentRepoFolder() {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' });
  return projectFolder(top.status === 0 && top.stdout.trim() ? top.stdout.trim() : process.cwd());
}

test('empty host reports not installed and exits nonzero', async (t) => {
  const host = await hostFixture(t);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(result.exitCode, 1);
  assert.match(renderDoctor(result), /installation: not installed/);
});

test('install file count agrees with doctor files check', async (t) => {
  const host = await hostFixture(t);
  const installed = await install({ host });
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const installedFiles = installed.output.match(/Installed (\d+) files and the Codex rules file/);
  const filesLine = renderDoctor(result).split('\n').find((line) => line.includes('files:'));
  assert.ok(installedFiles);
  assert.ok(filesLine);
  assert.match(filesLine, new RegExp(`${installedFiles[1]} installed file\\(s\\) present`));
});

test('complete installation with all files exits zero', async (t) => {
  const { host } = await installedFixture(t);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(result.exitCode, 0);
  assert.equal(result.checks.find((item) => item.key === 'files').status, 'ok');
  assert.equal(result.checks.find((item) => item.key === 'hook:SubagentStop').status, 'ok');
  const preToolUse = result.checks.filter((item) => item.key === 'hook:PreToolUse');
  assert.equal(
    preToolUse.length,
    HOOK_DEFINITIONS.filter(({ event }) => event === 'PreToolUse').length,
  );
  assert.ok(preToolUse.every((item) => item.status === 'ok'));
  for (const definition of HOOK_DEFINITIONS.filter(({ event }) => event === 'PreToolUse')) {
    const hook = preToolUse.find((item) => item.value.includes(definition.file));
    assert.match(hook.value, new RegExp(`matcher ${definition.matcher.replaceAll('|', '\\|')} ->`));
  }
  // Each line must name its own file. Matching the record by event alone reported the worktree
  // lock's matcher as pointing at order-gate.mjs, which is exactly the lie an operator reading
  // doctor cannot catch.
  for (const file of ['order-gate.mjs', 'worktree-lock.mjs', 'prune-guard.mjs', 'stop-guard.mjs']) {
    assert.equal(preToolUse.filter((item) => item.value.includes(file)).length, 1);
  }
});

test('doctor warns with the recorded and expected matcher when registration is outdated', async (t) => {
  const { host, record } = await installedFixture(t);
  const definition = HOOK_DEFINITIONS.find(({ name }) => name === 'worktree-lock');
  const recorded = record.hooks.find((hook) => hook.event === definition.event
    && path.basename(hook.path) === definition.file);
  const outdatedMatcher = 'Write|Edit|MultiEdit|NotebookEdit';
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  const group = settings.hooks[definition.event].find((item) => item.hooks
    .some((hook) => hook.command === recorded.command));
  group.matcher = outdatedMatcher;
  await fs.writeFile(host.settingsPath, `${JSON.stringify(settings)}\n`);

  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const hook = result.checks.find((item) => item.key === `hook:${definition.event}`
    && item.value.includes(definition.file));
  assert.equal(hook.status, 'warn');
  assert.match(hook.value, new RegExp(`matcher ${outdatedMatcher.replaceAll('|', '\\|')} ->`));
  assert.match(hook.value, new RegExp(`recorded matcher ${outdatedMatcher.replaceAll('|', '\\|')} differs from expected ${definition.matcher.replaceAll('|', '\\|')}`));
  assert.match(hook.value, /run codex-bridge update --force/);
});

test('absent hook registration keeps the existing warning', async (t) => {
  const { host } = await installedFixture(t);
  const definition = HOOK_DEFINITIONS.find(({ name }) => name === 'worktree-lock');
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  settings.hooks[definition.event] = settings.hooks[definition.event]
    .filter((group) => !group.hooks.some((hook) => hook.command.includes(definition.file)));
  await fs.writeFile(host.settingsPath, `${JSON.stringify(settings)}\n`);

  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const hook = result.checks.find((item) => item.key === `hook:${definition.event}`
    && item.value.includes(definition.file));
  assert.equal(hook.status, 'warn');
  assert.equal(hook.value, `${definition.event} matcher ${definition.matcher} does not point to the installed ${definition.file} (path command; installed copy ${ownPackage.name}@${ownPackage.version})`);
});

test('doctor reports the recorded hook form and the version that form executes', async (t) => {
  const { host, record } = await installedFixture(t);
  const shortHookRecord = record.hooks.find((hook) => hook.event === 'SubagentStop');
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  for (const group of settings.hooks.SubagentStop) {
    for (const hook of group.hooks) {
      if (hook.command === shortHookRecord.command) hook.command = 'codex-bridge hook reply-guard';
    }
  }
  await fs.writeFile(host.settingsPath, `${JSON.stringify(settings)}\n`);
  const result = await diagnose({
    host,
    codexProbe,
    bridgeProbe: () => ({ available: true, value: 'codex-bridge 8.8.8' }),
    currentPackage: ownPackage,
  });
  const shortHook = result.checks.find((item) => item.key === 'hook:SubagentStop');
  const pathHook = result.checks.find((item) => item.key === 'hook:PreToolUse'
    && item.value.includes('order-gate.mjs'));
  assert.equal(shortHook.status, 'warn');
  assert.match(shortHook.value, /short command;.*global command codex-bridge 8\.8\.8/);
  assert.match(shortHook.value, /global PATH package version 8\.8\.8 differs from clone version 0\.1\.0/);
  assert.match(pathHook.value, /path command;.*installed copy @lyupro\/codex-bridge@0\.1\.0/);
});

test('doctor warns when an installed hook cannot resolve an import', async (t) => {
  const { host } = await installedFixture(t);
  const definition = HOOK_DEFINITIONS[0];
  await fs.writeFile(
    path.join(host.brandHooksDir, definition.file),
    "import '../lib/missing-doctor-dependency.mjs';\n",
  );

  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const hook = result.checks.find((item) => item.key === `hook:${definition.event}`
    && item.value.includes(definition.file));
  assert.equal(hook.status, 'warn');
  assert.match(hook.value, /did not start/);
  assert.match(hook.value, /ERR_MODULE_NOT_FOUND/);
  assert.match(hook.value, /missing-doctor-dependency\.mjs/);
});

test('doctor warns for optional permissions without changing the exit code', async (t) => {
  const { host } = await installedFixture(t);
  const absent = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(absent.exitCode, 0);
  assert.equal(absent.checks.find((item) => item.key === 'permissions').status, 'warn');
  assert.match(renderDoctor(absent), /permissions: absent/);

  await addPermissionRules(host.settingsPath);
  const installed = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(installed.exitCode, 0);
  assert.equal(installed.checks.find((item) => item.key === 'permissions').status, 'ok');

  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  settings.permissions.allow.pop();
  await fs.writeFile(host.settingsPath, `${JSON.stringify(settings)}\n`);
  const partial = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(partial.exitCode, 0);
  assert.equal(partial.checks.find((item) => item.key === 'permissions').status, 'warn');
  assert.match(renderDoctor(partial), /permissions: partially installed/);
});
// A global install puts a second copy of the package beside any clone, and `update` copies host
// files from whichever copy was launched (Plan_19). Every other line here describes the host as
// seen by THIS copy, so the diagnosis has to say which one answered.
test('doctor names the copy of the package that answered', async (t) => {
  const host = await hostFixture(t);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const source = result.checks.find((item) => item.key === 'source');
  assert.equal(source.status, 'ok');
  assert.match(source.value, /\((clone|installed package)\)$/);
  assert.ok(path.isAbsolute(source.value.replace(/\s+\((clone|installed package)\)$/, '')));
  assert.equal(result.checks[0].key, 'source', 'the copy speaking comes before what it reports');
});

test('doctor reports an optional host conventions file when it is present', async (t) => {
  const { host } = await installedFixture(t);
  const file = host.brandConventionsPath;
  await fs.writeFile(file, '# operator rules\n');

  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.deepEqual(result.checks.find((item) => item.key === 'conventions'), {
    key: 'conventions',
    status: 'ok',
    value: `${file} (found)`,
  });
  assert.match(renderDoctor(result), /conventions: .*\(found\)/);
});

test('doctor warns when the host conventions file is empty', async (t) => {
  const { host } = await installedFixture(t);
  const file = host.brandConventionsPath;
  await fs.writeFile(file, ' \n\t');

  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.deepEqual(result.checks.find((item) => item.key === 'conventions'), {
    key: 'conventions',
    status: 'warn',
    value: `${file} (found but empty)`,
  });
  assert.equal(result.exitCode, 0);
  const line = renderDoctor(result).split('\n').find((entry) => entry.includes('conventions:'));
  assert.match(line, /^\u001b\[33m/);
  assert.match(line, /found but empty/);
  assert.match(line, /\u001b\[0m$/);
});

test('missing recorded file is a failure', async (t) => {
  const { host, record } = await installedFixture(t);
  await fs.rm(recordTarget(host, record.files[0]));
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.missingFiles, [`${record.files[0].root}/${record.files[0].path}`]);
  assert.equal(result.checks.find((item) => item.key === 'files').status, 'fail');
});

test('a directory at a recorded file path is treated as missing', async (t) => {
  const { host, record } = await installedFixture(t);
  const target = recordTarget(host, record.files[0]);
  await fs.rm(target);
  await fs.mkdir(target);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.missingFiles, [`${record.files[0].root}/${record.files[0].path}`]);
});

test('hook command must reference the exact installed guard path', async (t) => {
  const { host, record } = await installedFixture(t);
  const replyHook = record.hooks.find((hook) => hook.event === 'SubagentStop');
  const wrong = path.join(host.brandRoot, replyHook.path, 'reply-guard.mjs');
  await fs.writeFile(host.settingsPath, JSON.stringify({
    hooks: {
      SubagentStop: [{
        matcher: '*',
        hooks: [{ type: 'command', command: `node "${wrong}"` }],
      }],
    },
  }));
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(result.checks.find((item) => item.key === 'hook:SubagentStop').status, 'warn');
  assert.equal(result.checks.find((item) => item.key === 'hook:PreToolUse').status, 'warn');
});

test('doctor exposes a half-registered host as one healthy and one warning hook', async (t) => {
  const { host } = await installedFixture(t);
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  delete settings.hooks.PreToolUse;
  await fs.writeFile(host.settingsPath, `${JSON.stringify(settings)}\n`);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(result.checks.find((item) => item.key === 'hook:SubagentStop').status, 'ok');
  assert.equal(result.checks.find((item) => item.key === 'hook:PreToolUse').status, 'warn');
  assert.match(renderDoctor(result), /hook:PreToolUse:.*does not point|hook:PreToolUse:.*settings/);
});

test('an unreadable project marker fails one check, not the whole diagnosis', async (t) => {
  const { host } = await installedFixture(t);
  const runs = await runsRootFixture(t);
  const folder = path.join(runs, currentRepoFolder());
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, PROJECT_MARKER), '{ broken');
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(result.checks.find((item) => item.key === 'projectRuns').status, 'fail');
  assert.equal(result.exitCode, 1);
  assert.equal(result.checks.find((item) => item.key === 'files').status, 'ok');
});

test('doctor names the folder the runner would use, not the current subdirectory', async (t) => {
  const { host } = await installedFixture(t);
  await runsRootFixture(t);
  const repo = makeTempTree('bridge-repo-');
  spawnSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  const nested = path.join(repo, 'src', 'runner');
  await fs.mkdir(nested, { recursive: true });
  const previousCwd = process.cwd();
  process.chdir(nested);
  t.after(() => {
    process.chdir(previousCwd);
    removeTempTree(repo);
  });
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const [dir, note] = result.checks.find((item) => item.key === 'projectRuns').value.split(' (');
  assert.equal(path.basename(dir), projectFolder(repo));
  assert.notEqual(path.basename(dir), 'runner');
  assert.equal(note, 'not created yet)');
});

test('version mismatch is visible without treating intact files as broken', async (t) => {
  const { host } = await installedFixture(t);
  const result = await diagnose({
    host,
    codexProbe,
    currentPackage: { ...ownPackage, version: '9.0.0' },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.checks.find((item) => item.key === 'installation').status, 'warn');
});
