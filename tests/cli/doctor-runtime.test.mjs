/** Verifies what doctor reports about the host at runtime: cleanup policy and working runs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { diagnose, renderDoctor } from '../../cli/doctor.mjs';
import { HEARTBEAT_FILE, HEARTBEAT_STALE_MS } from '../../src/home/lib/heartbeat.mjs';
import { STOP_COMMAND_TEMPLATE } from '../../src/home/lib/stop-contract.mjs';
import { codexProbe, installedFixture, ownPackage, runsRootFixture } from './doctor-fixtures.mjs';

async function createWorkingRun(root, name, { heartbeat = true } = {}) {
  const dir = path.join(root, 'project', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'status.json'), `${JSON.stringify({
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    slug: name,
    repo: process.cwd(),
  })}\n`);
  if (heartbeat) await fs.writeFile(path.join(dir, HEARTBEAT_FILE), 'progress\n');
  return dir;
}

test('doctor warns in color with the configured automatic cleanup age', async (t) => {
  const { host } = await installedFixture(t);
  await fs.writeFile(
    host.brandConfigPath,
    JSON.stringify({ retention: { enabled: true, days: 7 } }),
  );

  const rendered = renderDoctor(await diagnose({ host, codexProbe, currentPackage: ownPackage }));

  assert.match(rendered, /Automatic cleanup is ON — run transport older than 7 days is removed to reclaim disk space\. Accounting and reports are never touched\. Change or disable: retention in config\.json\./);
  const retentionLine = rendered.split('\n').find((line) => line.includes('retention:'));
  assert.match(retentionLine, /^\u001b\[33m/);
  assert.match(retentionLine, /\u001b\[0m$/);
});

test('doctor reports disabled cleanup without warning color', async (t) => {
  const { host } = await installedFixture(t);
  await fs.writeFile(
    host.brandConfigPath,
    JSON.stringify({ retention: { enabled: false, days: 'not read' } }),
  );

  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rendered = renderDoctor(result);
  const retentionLine = rendered.split('\n').find((line) => line.includes('retention:'));

  assert.equal(result.checks.find((item) => item.key === 'retention').status, 'ok');
  assert.match(retentionLine, /Automatic cleanup is OFF/);
  assert.doesNotMatch(retentionLine, /\u001b/);
});

test('doctor counts only confirmed fresh working runs and keeps the host healthy', async (t) => {
  const { host } = await installedFixture(t);
  const runs = await runsRootFixture(t);

  const empty = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.deepEqual(empty.checks.find((item) => item.key === 'liveRuns'), {
    key: 'liveRuns', status: 'ok', value: '0 runs working right now',
  });
  assert.equal(empty.exitCode, 0);

  const live = await createWorkingRun(runs, 'live');
  const working = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.deepEqual(working.checks.find((item) => item.key === 'liveRuns'), {
    key: 'liveRuns', status: 'warn', value: `1 run working right now; stop with ${STOP_COMMAND_TEMPLATE}`,
  });
  assert.equal(working.exitCode, 0);
  assert.match(renderDoctor(working), /\u001b\[33m\[warn\] liveRuns:/);

  await fs.rm(live, { recursive: true, force: true });
  const stale = await createWorkingRun(runs, 'stale');
  const heartbeat = path.join(stale, HEARTBEAT_FILE);
  const old = new Date(Date.now() - HEARTBEAT_STALE_MS - 1_000);
  await fs.utimes(heartbeat, old, old);
  const staleResult = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(staleResult.checks.find((item) => item.key === 'liveRuns').value, '0 runs working right now');
  assert.equal(staleResult.checks.find((item) => item.key === 'liveRuns').status, 'ok');

  await fs.rm(stale, { recursive: true, force: true });
  await createWorkingRun(runs, 'unconfirmed', { heartbeat: false });
  const unconfirmed = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.equal(unconfirmed.checks.find((item) => item.key === 'liveRuns').value, '0 runs working right now');
  assert.equal(unconfirmed.checks.find((item) => item.key === 'liveRuns').status, 'ok');
});
