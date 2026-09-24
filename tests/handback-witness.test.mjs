import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withTempTree } from './temp-tree.mjs';
import {
  hostSdkVersion,
  readHandbackWitness,
  recordHandbackWitness,
} from '../src/home/lib/handback-witness.mjs';

test('host SDK version is trimmed and absent values are null', () => {
  assert.equal(hostSdkVersion({ CLAUDE_AGENT_SDK_VERSION: '  0.3.281  ' }), '0.3.281');
  assert.equal(hostSdkVersion({}), null);
  assert.equal(hostSdkVersion({ CLAUDE_AGENT_SDK_VERSION: '  ' }), null);
});

test('seen records the most recent intercepted handback', async () => {
  await withTempTree('handback-witness-seen-', async (stateDir) => {
    const witness = await recordHandbackWitness({
      stateDir,
      kind: 'seen',
      sdkVersion: '0.3.281',
      now: new Date('2026-09-24T10:00:00Z'),
    });
    assert.deepEqual(witness, {
      lastSeen: { sdkVersion: '0.3.281', at: '2026-09-24T10:00:00.000Z' },
      alarms: [],
    });
    assert.deepEqual(readHandbackWitness({ stateDir }), witness);
  });
});

test('alarms append and retain only the newest twenty entries', async () => {
  await withTempTree('handback-witness-alarm-', async (stateDir) => {
    for (let index = 0; index < 21; index += 1) {
      await recordHandbackWitness({
        stateDir,
        kind: 'alarm',
        sdkVersion: null,
        detail: `alarm-${index}`,
        now: new Date(1_000 + index),
      });
    }
    const witness = readHandbackWitness({ stateDir });
    assert.equal(witness.alarms.length, 20);
    assert.equal(witness.alarms[0].detail, 'alarm-1');
    assert.equal(witness.alarms.at(-1).detail, 'alarm-20');
    assert.equal(witness.lastSeen, null);
  });
});

test('unknown witness kinds throw before writing', async () => {
  await withTempTree('handback-witness-kind-', async (stateDir) => {
    await assert.rejects(recordHandbackWitness({ stateDir, kind: 'unknown', sdkVersion: null }), TypeError);
    assert.deepEqual(readHandbackWitness({ stateDir }), { lastSeen: null, alarms: [] });
  });
});

test('witness reads distinguish absent records from corrupt JSON', async () => {
  await withTempTree('handback-witness-corrupt-', async (stateDir) => {
    assert.deepEqual(readHandbackWitness({ stateDir }), { lastSeen: null, alarms: [] });
    fs.writeFileSync(path.join(stateDir, 'handback-witness.json'), '{bad json');
    assert.deepEqual(readHandbackWitness({ stateDir }), { corrupt: true });
  });
});
