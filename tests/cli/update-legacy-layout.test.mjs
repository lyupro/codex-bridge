/** Verifies that update retires the previous layout even when everything else is already current. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { update } from '../../cli/update.mjs';
import { installRecordPath, legacyInstallRecordPath } from '../../cli/manifest.mjs';

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

test('the dry run names the registrations it would take away', async (t) => {
  // It printed "the previous undefined hook registration" five times during the real Plan_25
  // migration — on the one run whose whole purpose is telling the operator what is about to go.
  const host = await fixture(t);
  await install({ host });
  const recordPath = installRecordPath(host);
  const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  // A hook entry is only valid when the record's file list names the same path, so both move.
  const moved = new Map(record.hooks.map((hook) => [
    `${hook.root}:${hook.path}`,
    { root: 'claude', path: `agents/codex/hooks/${path.basename(hook.path)}` },
  ]));
  record.files = record.files.map((file) => moved.get(`${file.root}:${file.path}`) ?? file);
  record.hooks = record.hooks.map((hook) => ({ ...hook, ...moved.get(`${hook.root}:${hook.path}`) }));
  for (const [key, target] of moved) {
    const [fromRoot, fromPath] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const fingerprint = record.fingerprints?.[fromRoot]?.[fromPath];
    if (fingerprint === undefined) continue;
    delete record.fingerprints[fromRoot][fromPath];
    record.fingerprints[target.root] = { ...record.fingerprints[target.root], [target.path]: fingerprint };
  }
  await fs.writeFile(recordPath, `${JSON.stringify(record)}\n`);
  const result = await update({ host, dryRun: true });
  assert.equal(result.output.includes('undefined'), false, result.output);
  assert.match(result.output, /Would remove the previous SubagentStop hook registration for matcher \*\./);
});

test('a dry run retires nothing', async (t) => {
  const host = await fixture(t);
  await installedWithLeftoverLegacy(host);
  await update({ host, dryRun: true });
  await fs.access(legacyInstallRecordPath(host));
  await fs.access(host.legacyAgentsDir);
});
