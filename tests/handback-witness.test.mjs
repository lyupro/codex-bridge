import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withTempTree } from './temp-tree.mjs';
import {
  readHandbackWitness,
  recordHandbackWitness,
} from '../src/home/lib/handback-witness.mjs';

test('seen records the most recent intercepted handback', async () => {
  await withTempTree('handback-witness-seen-', async (tree) => {
    const stateDir = path.join(tree, 'state');
    fs.mkdirSync(stateDir);
    const witness = await recordHandbackWitness({
      stateDir,
      kind: 'seen',
      hostVersion: '2.1.281',
      now: new Date('2026-09-24T10:00:00Z'),
    });
    assert.deepEqual(witness, {
      lastSeen: { '2.1.281': '2026-09-24T10:00:00.000Z' },
      alarms: [],
    });
    assert.deepEqual(readHandbackWitness({ stateDir }), witness);
  });
});

test('alarms append and retain only the newest twenty entries', async () => {
  await withTempTree('handback-witness-alarm-', async (tree) => {
    const stateDir = path.join(tree, 'state');
    fs.mkdirSync(stateDir);
    for (let index = 0; index < 21; index += 1) {
      await recordHandbackWitness({
        stateDir,
        kind: 'alarm',
        hostVersion: null,
        detail: `alarm-${index}`,
        now: new Date(1_000 + index),
      });
    }
    const witness = readHandbackWitness({ stateDir });
    assert.equal(witness.alarms.length, 20);
    assert.equal(witness.alarms[0].detail, 'alarm-1');
    assert.equal(witness.alarms.at(-1).detail, 'alarm-20');
    assert.deepEqual(witness.lastSeen, {});
  });
});

test('unknown witness kinds throw before writing', async () => {
  await withTempTree('handback-witness-kind-', async (tree) => {
    const stateDir = path.join(tree, 'state');
    fs.mkdirSync(stateDir);
    await assert.rejects(recordHandbackWitness({ stateDir, kind: 'unknown', hostVersion: null }), TypeError);
    assert.deepEqual(readHandbackWitness({ stateDir }), { lastSeen: {}, alarms: [] });
  });
});

test('witness reads distinguish absent records from corrupt JSON', async () => {
  await withTempTree('handback-witness-corrupt-', async (tree) => {
    const stateDir = path.join(tree, 'state');
    fs.mkdirSync(stateDir);
    assert.deepEqual(readHandbackWitness({ stateDir }), { lastSeen: {}, alarms: [] });
    fs.writeFileSync(path.join(stateDir, 'handback-witness.json'), '{bad json');
    assert.deepEqual(readHandbackWitness({ stateDir }), { corrupt: true });
  });
});

test('legacy SDK witness becomes no host sighting and preserves alarms', async () => {
  await withTempTree('handback-witness-legacy-', async (tree) => {
    const stateDir = path.join(tree, 'state');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, 'handback-witness.json'), JSON.stringify({
      lastSeen: { sdkVersion: '0.3.281', at: '2026-09-24T10:00:00.000Z' },
      alarms: [{ sdkVersion: '0.3.281', at: '2026-09-24T10:01:00.000Z', detail: 'old alarm' }],
    }));
    assert.deepEqual(readHandbackWitness({ stateDir }), {
      lastSeen: {}, alarms: [{ hostVersion: null, at: '2026-09-24T10:01:00.000Z', detail: 'old alarm' }],
    });
  });
});
