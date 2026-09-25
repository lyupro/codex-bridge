import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HOST_OBSERVATIONS_FILE, observeSessionHost, readHostObservations } from '../src/home/lib/host-observations.mjs';
import { makeTempTree, removeTempTree } from './temp-tree.mjs';

async function fixture(t) {
  const root = makeTempTree('bridge-host-observations-');
  t.after(() => removeTempTree(root));
  const stateDir = path.join(root, 'state');
  await fs.mkdir(stateDir);
  return { root, stateDir };
}

test('records a session and avoids rereading its version on subsequent calls', async (t) => {
  const { stateDir } = await fixture(t);
  let reads = 0;
  const readVersion = async () => { reads += 1; return '1.2.3'; };
  assert.deepEqual(await observeSessionHost({ stateDir, sessionId: 's1', transcriptPath: 'unused', readVersion }), { recorded: true });
  assert.deepEqual(await observeSessionHost({ stateDir, sessionId: 's1', transcriptPath: 'unused', readVersion }), { recorded: false });
  assert.equal(reads, 1);
  assert.equal(readHostObservations({ stateDir }).sessions.s1.version, '1.2.3');
});

test('does not mark a session when its transcript has no host version', async (t) => {
  const { stateDir } = await fixture(t);
  assert.deepEqual(await observeSessionHost({ stateDir, sessionId: 's1', transcriptPath: 'unused', readVersion: async () => null }), { recorded: false });
  assert.deepEqual(readHostObservations({ stateDir }).sessions, {});
});

test('keeps observations for multiple host versions', async (t) => {
  const { stateDir } = await fixture(t);
  for (const [sessionId, version] of [['s1', '1.2.3'], ['s2', '2.3.4']]) {
    await observeSessionHost({ stateDir, sessionId, transcriptPath: 'unused', readVersion: async () => version });
  }
  assert.deepEqual(Object.keys(readHostObservations({ stateDir }).hosts).sort(), ['1.2.3', '2.3.4']);
});

test('prunes old sessions and hosts', async (t) => {
  const { stateDir } = await fixture(t);
  await fs.writeFile(path.join(stateDir, HOST_OBSERVATIONS_FILE), JSON.stringify({
    sessions: { old: { version: '1.0.0', at: '2020-01-01T00:00:00.000Z' } },
    hosts: { '1.0.0': { firstSeen: '2020-01-01T00:00:00.000Z', lastSeen: '2020-01-01T00:00:00.000Z' } },
  }));
  await observeSessionHost({ stateDir, sessionId: 'new', transcriptPath: 'unused', now: new Date('2026-09-25T00:00:00Z'), readVersion: async () => '2.0.0' });
  const state = readHostObservations({ stateDir });
  assert.deepEqual(Object.keys(state.sessions), ['new']);
  assert.deepEqual(Object.keys(state.hosts), ['2.0.0']);
});

test('refuses corrupt state and preserves its bytes', async (t) => {
  const { stateDir } = await fixture(t);
  const file = path.join(stateDir, HOST_OBSERVATIONS_FILE);
  const corrupt = Buffer.from('{bad json\n');
  await fs.writeFile(file, corrupt);
  await assert.rejects(observeSessionHost({ stateDir, sessionId: 's1', transcriptPath: 'unused', readVersion: async () => '1.2.3' }));
  assert.deepEqual(await fs.readFile(file), corrupt);
});
