/** Verifies doctor decisions for absent, complete, and damaged installations. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { diagnose, renderDoctor } from '../../cli/doctor.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { writeInstallRecord } from '../../cli/manifest.mjs';

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
