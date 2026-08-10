/** Verifies that update retires the previous layout even when everything else is already current. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { update } from '../../cli/update.mjs';
import { legacyInstallRecordPath } from '../../cli/manifest.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-legacy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
}

/**
 * Reproduces an update that installed the new layout and then stopped — power loss, a killed
 * terminal — before it removed the old record and directories. Every later update found each file
 * current and returned "up to date" without retrying, so agents/codex sat beside
 * agents/codex-bridge indefinitely.
 */
async function installedWithLeftoverLegacy(host) {
  await install({ host });
  await fs.mkdir(host.legacyAgentsDir, { recursive: true });
  await fs.mkdir(host.legacyCommandsDir, { recursive: true });
  await fs.writeFile(legacyInstallRecordPath(host), `${JSON.stringify({ version: '0.4.0', files: [] })}\n`);
}

test('an up-to-date install still retires a leftover previous layout', async (t) => {
  const host = await fixture(t);
  await installedWithLeftoverLegacy(host);
  const result = await update({ host });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'codex-bridge is up to date');
  await assert.rejects(() => fs.access(legacyInstallRecordPath(host)), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(host.legacyAgentsDir), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(host.legacyCommandsDir), { code: 'ENOENT' });
});

test('retiring the previous layout leaves the shared host directories alone', async (t) => {
  const host = await fixture(t);
  await installedWithLeftoverLegacy(host);
  await update({ host });
  await fs.access(path.join(host.root, 'agents'));
  await fs.access(path.join(host.root, 'commands'));
});

test('a previous-layout directory holding a foreign file is not removed', async (t) => {
  const host = await fixture(t);
  await installedWithLeftoverLegacy(host);
  const foreign = path.join(host.legacyAgentsDir, 'operator-notes.md');
  await fs.writeFile(foreign, 'mine\n');
  await update({ host });
  await fs.access(foreign);
});

test('a dry run retires nothing', async (t) => {
  const host = await fixture(t);
  await installedWithLeftoverLegacy(host);
  await update({ host, dryRun: true });
  await fs.access(legacyInstallRecordPath(host));
  await fs.access(host.legacyAgentsDir);
});
