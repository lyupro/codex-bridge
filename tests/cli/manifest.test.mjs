/** Verifies install planning, placeholder expansion, and installation record validation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import {
  INSTALL_TABLE,
  buildInstallPlan,
  readInstallRecord,
  replacePlaceholders,
  validateInstallRecord,
  writeInstallRecord,
} from '../../cli/manifest.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-manifest-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'package');
  const host = resolveHost({ host: path.join(root, 'host') });
  await fs.mkdir(path.join(packageRoot, 'src', 'agents'), { recursive: true });
  await fs.mkdir(path.join(packageRoot, 'src', 'commands'), { recursive: true });
  await fs.mkdir(path.join(packageRoot, 'src', 'hooks'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'src', 'agents', 'build.md'), 'agent');
  await fs.writeFile(path.join(packageRoot, 'src', 'agents', 'notes.txt'), 'notes');
  await fs.writeFile(path.join(packageRoot, 'src', 'commands', 'env.md'), 'command');
  await fs.writeFile(path.join(packageRoot, 'src', 'hooks', 'guard.mjs'), 'guard');
  return { root, packageRoot, host };
}

const record = {
  name: '@lyupro/codex-bridge',
  version: '0.1.0',
  installedAt: '2026-08-02T10:00:00.000Z',
  mode: 'copy',
  files: ['agents/codex/run-codex.mjs', 'agents/codex/hooks/reply-guard.mjs'],
  hook: { event: 'SubagentStop', path: 'agents/codex/hooks/reply-guard.mjs' },
};

test('installation table is exported data', () => {
  assert.deepEqual(INSTALL_TABLE, [
    { source: 'src/agents/*.md', target: 'agentsDir', processing: 'placeholders' },
    { source: 'src/commands/*.md', target: 'commandsDir', processing: 'placeholders' },
    { source: 'src/**', target: 'agentsDir', processing: 'copy' },
  ]);
});

test('install plan maps agents, commands, and remaining src files', async (t) => {
  const { packageRoot, host } = await fixture(t);
  const plan = await buildInstallPlan(host, packageRoot);
  assert.deepEqual(plan.map((item) => item.relativeToHost), [
    'agents/codex/agents/notes.txt',
    'agents/codex/build.md',
    'agents/codex/hooks/guard.mjs',
    'commands/codex/env.md',
  ]);
  assert.deepEqual(plan.map((item) => item.processing), ['copy', 'placeholders', 'copy', 'placeholders']);
});

test('placeholder becomes an absolute POSIX agents path', () => {
  const agentsDir = path.resolve('C:\\fixture\\host\\agents\\codex');
  const replaced = replacePlaceholders('node "{{CODEX_BRIDGE_DIR}}/run.mjs"', agentsDir);
  assert.equal(replaced, `node "${agentsDir.split(path.sep).join('/')}/run.mjs"`);
  assert.doesNotMatch(replaced, /\{\{CODEX_BRIDGE_DIR\}\}/);
});

test('installation record writes and reads after validation', async (t) => {
  const { host } = await fixture(t);
  await fs.mkdir(host.agentsDir, { recursive: true });
  await writeInstallRecord(host, record);
  assert.deepEqual(await readInstallRecord(host), record);
});

test('missing record reads as not installed', async (t) => {
  const { host } = await fixture(t);
  assert.equal(await readInstallRecord(host), null);
});

test('malformed and structurally broken records fail loudly', async (t) => {
  const { host } = await fixture(t);
  await fs.mkdir(host.agentsDir, { recursive: true });
  await fs.writeFile(path.join(host.agentsDir, '.codex-bridge-install.json'), '{ nope');
  await assert.rejects(() => readInstallRecord(host), /invalid installation record JSON/);
  assert.throws(() => validateInstallRecord({ ...record, files: [3] }), /files/);
  assert.throws(() => validateInstallRecord({ ...record, files: [] }), /non-empty list/);
  assert.throws(() => validateInstallRecord({ ...record, files: ['.'] }), /host root/);
  assert.throws(() => validateInstallRecord({ ...record, files: ['../outside.mjs'] }), /host root/);
  assert.throws(() => validateInstallRecord({ ...record, hook: null }), /hook/);
  assert.throws(() => validateInstallRecord({ ...record, hook: { event: 'SubagentStop', path: record.files[0] } }), /reply-guard/);
});
