/**
 * Holds `update` to removing exactly the three guard files older releases left in Claude Code's own
 * `~/.claude/logs/` (Plan_62 D14 moved them into the package's state/), and nothing else there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { update } from '../../cli/update.mjs';
import { installOutdated } from './update-fixtures.mjs';

const LEGACY_GUARD_LOG_FILES = [
  'codex-reply-guard.blocked.json',
  'codex-order-gate.last.json',
  'codex-reply-guard.last.json',
];

async function seedLogs(host, content) {
  const logDir = path.join(path.dirname(host.settingsPath), 'logs');
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(path.join(logDir, 'operator-notes.txt'), 'keep this file\n');
  for (const name of LEGACY_GUARD_LOG_FILES) await fs.writeFile(path.join(logDir, name), content);
  return logDir;
}

async function assertRemoved(output, logDir) {
  for (const name of LEGACY_GUARD_LOG_FILES) {
    assert.ok(output.includes(`Removed ${path.join('logs', name)}.`), `${name} removal is named`);
    await assert.rejects(fs.access(path.join(logDir, name)), { code: 'ENOENT' });
  }
  assert.equal(await fs.readFile(path.join(logDir, 'operator-notes.txt'), 'utf8'), 'keep this file\n');
}

test('update removes only the three legacy guard logs on changed and up-to-date paths', async (t) => {
  const { host } = await installOutdated(t);
  const logDir = await seedLogs(host, 'legacy\n');
  const changed = await update({ host });
  assert.equal(changed.exitCode, 0);
  await assertRemoved(changed.output, logDir);

  await seedLogs(host, 'legacy again\n');
  const current = await update({ host });
  assert.equal(current.exitCode, 0);
  await assertRemoved(current.output, logDir);
});

test('--dry-run names the legacy guard logs without removing them', async (t) => {
  const { host } = await installOutdated(t);
  const logDir = await seedLogs(host, 'legacy\n');
  const result = await update({ host, dryRun: true });
  assert.equal(result.exitCode, 0);
  for (const name of LEGACY_GUARD_LOG_FILES) {
    assert.ok(result.output.includes(`Would remove ${path.join('logs', name)}.`), `${name} is named`);
    assert.equal(await fs.readFile(path.join(logDir, name), 'utf8'), 'legacy\n');
  }
  assert.equal(await fs.readFile(path.join(logDir, 'operator-notes.txt'), 'utf8'), 'keep this file\n');
});
