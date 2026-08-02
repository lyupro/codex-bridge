/** Verifies doctor decisions for absent, complete, and damaged installations. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { diagnose, renderDoctor } from '../../cli/doctor.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { writeInstallRecord } from '../../cli/manifest.mjs';
import { PROJECT_MARKER } from '../../src/runner/project-dir.mjs';
import { projectFolder } from '../../src/write-meta.mjs';

const ownPackage = { name: '@lyupro/codex-bridge', version: '0.1.0' };
const codexProbe = () => ({ available: true, value: 'codex-cli 1.2.3' });

async function hostFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-doctor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return resolveHost({ host: root });
}

async function installedFixture(t) {
  const host = await hostFixture(t);
  const files = ['agents/codex/run-codex.mjs', 'agents/codex/hooks/reply-guard.mjs'];
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
    hook: { event: 'SubagentStop', path: 'agents/codex/hooks/reply-guard.mjs' },
  };
  await writeInstallRecord(host, record);
  await fs.writeFile(host.settingsPath, JSON.stringify({
    hooks: {
      SubagentStop: [{ hooks: [{ type: 'command', command: `node "${path.join(host.root, record.hook.path)}"` }] }],
    },
  }));
  return { host, record };
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
  assert.equal(result.checks.find((item) => item.key === 'hook').status, 'ok');
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
  const wrong = path.join(host.root, record.hook.path, 'reply-guard.mjs');
  await fs.writeFile(host.settingsPath, JSON.stringify({
    hooks: {
      SubagentStop: [{
        matcher: path.join(host.root, record.hook.path),
        hooks: [{ type: 'command', command: `node "${wrong}"` }],
      }],
    },
  }));
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(result.checks.find((item) => item.key === 'hook').status, 'warn');
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
