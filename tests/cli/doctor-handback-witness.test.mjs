/** Verifies the handback witness is exposed by doctor using the fixture host's brand home. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { diagnose } from '../../cli/doctor.mjs';
import { recordHandbackWitness } from '../../src/home/lib/handback-witness.mjs';
import { brandStateDir } from '../../src/home/lib/brand-home.mjs';
import { codexProbe, installedFixture, ownPackage } from './doctor-fixtures.mjs';

test('doctor reports an unobserved witness as ok', async (t) => {
  const { host } = await installedFixture(t);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage, hostVersion: '2.1.281' });
  assert.deepEqual(result.checks.find((item) => item.key === 'handbackWitness'), {
    key: 'handbackWitness', status: 'ok',
    value: 'Not observed yet — a handback is seen only when a dispatcher runs in an interactive session.',
  });
});

test('doctor warns after a recorded dispatcher alarm', async (t) => {
  const { host } = await installedFixture(t);
  await recordHandbackWitness({
    stateDir: brandStateDir(host.brandRoot), kind: 'alarm', hostVersion: '2.1.281',
    detail: 'dispatcher bypassed gate', now: new Date('2026-09-24T10:00:00.000Z'),
  });
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage, hostVersion: '2.1.282' });
  const witness = result.checks.find((item) => item.key === 'handbackWitness');
  assert.equal(witness.status, 'warn');
  assert.match(witness.value, /dispatcher bypassed gate at 2026-09-24T10:00:00/);
});
