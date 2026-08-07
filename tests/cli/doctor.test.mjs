/** Verifies doctor decisions for absent, complete, and damaged installations. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { diagnose, renderDoctor } from '../../cli/doctor.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { fileFingerprint, HOOK_DEFINITIONS, writeInstallRecord } from '../../cli/manifest.mjs';
import { RULES_REGISTRY_NAME } from '../../cli/rules-owners.mjs';
import { normalizeRepoPath, PROJECT_MARKER } from '../../src/runner/project-dir.mjs';
import { projectFolder } from '../../src/write-meta.mjs';

const ownPackage = { name: '@lyupro/codex-bridge', version: '0.1.0' };
const codexProbe = () => ({ available: true, value: 'codex-cli 1.2.3' });

async function hostFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-doctor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return resolveHost({ host: root, codexHome: path.join(root, 'codex-home') });
}

async function installedFixture(t) {
  const host = await hostFixture(t);
  const files = [
    'agents/codex/run-codex.mjs',
    'agents/codex/required-inputs.mjs',
    'agents/codex/hooks/reply-guard.mjs',
    'agents/codex/hooks/order-gate.mjs',
    'agents/codex/hooks/live-runs.mjs',
    'agents/codex/hooks/worktree-lock.mjs',
    'agents/codex/hooks/prune-guard.mjs',
  ];
  for (const relative of files) {
    const target = path.join(host.root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, relative);
  }
  const record = {
    ...ownPackage,
    installedAt: '2026-08-02T10:00:00.000Z',
    mode: 'copy',
    files,
    hooks: [
      { event: 'SubagentStop', path: 'agents/codex/hooks/reply-guard.mjs' },
      { event: 'PreToolUse', path: 'agents/codex/hooks/order-gate.mjs' },
      { event: 'PreToolUse', path: 'agents/codex/hooks/worktree-lock.mjs' },
      { event: 'PreToolUse', path: 'agents/codex/hooks/prune-guard.mjs' },
    ],
  };
  await writeInstallRecord(host, record);
  // Registered from the definitions, not from literals: doctor compares the matcher it finds
  // against the one the installer would write, so a fixture with its own copy would report a
  // healthy host green while the real one drifted.
  const hooks = {};
  for (const definition of HOOK_DEFINITIONS) {
    const recorded = record.hooks.find((hook) => path.basename(hook.path) === definition.file);
    hooks[definition.event] ??= [];
    hooks[definition.event].push({
      matcher: definition.matcher,
      hooks: [{ type: 'command', command: `node "${path.join(host.root, recorded.path)}"` }],
    });
  }
  await fs.writeFile(host.settingsPath, JSON.stringify({ hooks }));
  return { host, record };
}

async function addRules(host, record, content = 'prefix_rule(pattern=["safe"], decision="allow")\n') {
  const rulePath = path.join(host.codexRulesDir, 'codex-bridge.rules');
  await fs.mkdir(path.dirname(rulePath), { recursive: true });
  await fs.writeFile(rulePath, content);
  record.rules = { path: rulePath, fingerprint: await fileFingerprint(rulePath) };
  await writeInstallRecord(host, record);
  return rulePath;
}

async function runsRootFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-runs-'));
  const previous = process.env.CODEX_RUNS_ROOT;
  process.env.CODEX_RUNS_ROOT = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_RUNS_ROOT;
    else process.env.CODEX_RUNS_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

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
  // Each line must name its own file. Matching the record by event alone reported the worktree
  // lock's matcher as pointing at order-gate.mjs, which is exactly the lie an operator reading
  // doctor cannot catch.
  for (const file of ['order-gate.mjs', 'worktree-lock.mjs', 'prune-guard.mjs']) {
    assert.equal(preToolUse.filter((item) => item.value.endsWith(file)).length, 1);
  }
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
  const file = path.join(host.agentsDir, 'conventions.md');
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
  const file = path.join(host.agentsDir, 'conventions.md');
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

test('rules cannot be checked before installation', async (t) => {
  const host = await hostFixture(t);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.deepEqual(result.checks.find((item) => item.key === 'rules'), {
    key: 'rules',
    status: 'warn',
    value: 'cannot check before installation',
  });
});

test('an old installation record warns that update will add rules', async (t) => {
  const { host } = await installedFixture(t);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rules = result.checks.find((item) => item.key === 'rules');
  assert.equal(rules.status, 'warn');
  assert.match(rules.value, /not installed by this installation/i);
  assert.match(rules.value, /install or update/i);
});

test('rules matching their recorded fingerprint are healthy', async (t) => {
  const { host, record } = await installedFixture(t);
  const rulePath = await addRules(host, record);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.deepEqual(result.checks.find((item) => item.key === 'rules'), {
    key: 'rules',
    status: 'ok',
    value: `${rulePath} (matches record)`,
  });
  assert.equal(result.exitCode, 0);
});

test('doctor reports multiple owners of shared rules', async (t) => {
  const { host, record } = await installedFixture(t);
  await addRules(host, record);
  const otherHost = path.join(path.dirname(host.root), 'other-host');
  await fs.writeFile(
    path.join(host.codexRulesDir, RULES_REGISTRY_NAME),
    `${JSON.stringify({
      version: 1,
      owners: [normalizeRepoPath(host.root), normalizeRepoPath(otherHost)],
    }, null, 2)}\n`,
  );
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rules = result.checks.find((item) => item.key === 'rules');
  assert.equal(rules.status, 'ok');
  assert.match(rules.value, /2 owners/);
  assert.match(renderDoctor(result), /rules: .*2 owners/);
});

test('corrupt rules registry fails only the rules check and keeps all diagnostics', async (t) => {
  const { host, record } = await installedFixture(t);
  await addRules(host, record);
  await fs.writeFile(
    path.join(host.codexRulesDir, RULES_REGISTRY_NAME),
    '{"version":1,"owners":[',
  );
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rendered = renderDoctor(result);
  for (const key of ['source', 'host', 'installation', 'files', 'rules', 'hook:SubagentStop', 'hook:PreToolUse', 'codex', 'node', 'runsRoot', 'projectRuns']) {
    assert.match(rendered, new RegExp(`\\] ${key}:`));
  }
  const rules = result.checks.find((item) => item.key === 'rules');
  assert.equal(rules.status, 'fail');
  assert.match(rules.value, /invalid rules ownership registry JSON/);
  assert.equal(result.exitCode, 1);
});

test('missing recorded rules fail diagnosis and name their full path', async (t) => {
  const { host, record } = await installedFixture(t);
  const rulePath = await addRules(host, record);
  await fs.rm(rulePath);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.deepEqual(result.checks.find((item) => item.key === 'rules'), {
    key: 'rules',
    status: 'fail',
    value: rulePath,
  });
  assert.equal(result.exitCode, 1);
});

test('manually modified rules warn without failing diagnosis', async (t) => {
  const { host, record } = await installedFixture(t);
  const rulePath = await addRules(host, record);
  await fs.writeFile(rulePath, 'manual operator rules\n');
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rules = result.checks.find((item) => item.key === 'rules');
  assert.equal(rules.status, 'warn');
  assert.match(rules.value, /modified after installation/i);
  assert.match(rules.value, new RegExp(rulePath.replaceAll('\\', '\\\\')));
  assert.equal(result.exitCode, 0);
});

test('missing recorded file is a failure', async (t) => {
  const { host, record } = await installedFixture(t);
  await fs.rm(path.join(host.root, record.files[0]));
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.missingFiles, [record.files[0]]);
  assert.equal(result.checks.find((item) => item.key === 'files').status, 'fail');
});

test('a directory at a recorded file path is treated as missing', async (t) => {
  const { host, record } = await installedFixture(t);
  const target = path.join(host.root, record.files[0]);
  await fs.rm(target);
  await fs.mkdir(target);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.missingFiles, [record.files[0]]);
});

test('hook command must reference the exact installed guard path', async (t) => {
  const { host, record } = await installedFixture(t);
  const replyHook = record.hooks.find((hook) => hook.event === 'SubagentStop');
  const wrong = path.join(host.root, replyHook.path, 'reply-guard.mjs');
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
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-repo-'));
  spawnSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
  const nested = path.join(repo, 'src', 'runner');
  await fs.mkdir(nested, { recursive: true });
  const previousCwd = process.cwd();
  process.chdir(nested);
  t.after(async () => {
    process.chdir(previousCwd);
    await fs.rm(repo, { recursive: true, force: true });
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

test('doctor warns in color with the configured automatic cleanup age', async (t) => {
  const { host } = await installedFixture(t);
  await fs.writeFile(
    path.join(host.agentsDir, 'run-config.json'),
    JSON.stringify({ retention: { enabled: true, days: 7 } }),
  );

  const rendered = renderDoctor(await diagnose({ host, codexProbe, currentPackage: ownPackage }));

  assert.match(rendered, /Automatic cleanup is ON — run transport older than 7 days is removed to reclaim disk space\. Accounting and reports are never touched\. Change or disable: retention in run-config\.json\./);
  const retentionLine = rendered.split('\n').find((line) => line.includes('retention:'));
  assert.match(retentionLine, /^\u001b\[33m/);
  assert.match(retentionLine, /\u001b\[0m$/);
});

test('doctor reports disabled cleanup without warning color', async (t) => {
  const { host } = await installedFixture(t);
  await fs.writeFile(
    path.join(host.agentsDir, 'run-config.json'),
    JSON.stringify({ retention: { enabled: false, days: 'not read' } }),
  );

  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rendered = renderDoctor(result);
  const retentionLine = rendered.split('\n').find((line) => line.includes('retention:'));

  assert.equal(result.checks.find((item) => item.key === 'retention').status, 'ok');
  assert.match(retentionLine, /Automatic cleanup is OFF/);
  assert.doesNotMatch(retentionLine, /\u001b/);
});
