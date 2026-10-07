/** Covers every operator-visible handback witness state on the per-cause ledger. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { handbackWitnessStatus } from '../../cli/handback-witness-check.mjs';
import {
  readHandbackWitness, recordInterceptedAttempt, recordWitnessObservation, witnessKey, WITNESS_FILE,
} from '../../src/home/lib/handback-witness.mjs';
import { entryState } from '../../src/home/lib/observation-ledger.mjs';
import { withTempTree } from '../temp-tree.mjs';

async function withStateTree(prefix, action) {
  return withTempTree(prefix, async (root) => {
    const stateDir = path.join(root, 'state');
    await fs.mkdir(stateDir);
    return action(stateDir);
  });
}

const hostVersion = '2.1.281';
const at = '2026-09-24T10:00:00.000Z';
const later = '2026-09-24T11:00:00.000Z';
const options = { cause: 'tools-outside-gate', hostVersion, agentType: 'codex-build' };
const observe = (stateDir, fields = {}) => recordWitnessObservation({
  stateDir, ...options, verdict: 'violation', detail: 'dispatcher bypassed gate', now: new Date(at), ...fields,
});
const status = (stateDir, host = hostVersion) => handbackWitnessStatus({
  record: readHandbackWitness({ stateDir }), hostVersion: host, stateDir,
});
function oneHistory(message) {
  assert.equal(message.match(/History:/g)?.length, 1);
  assert.equal(message.slice(message.indexOf('History:')).match(/\./g)?.length, 1);
}

test('corrupt witness identifies the file to delete', async () => {
  await withStateTree('bridge-witness-check-corrupt-', async (stateDir) => {
    await fs.writeFile(path.join(stateDir, WITNESS_FILE), '{ broken');
    const result = status(stateDir);
    assert.equal(result.state, 'unreadable');
    assert.match(result.message, /handback-witness\.json/);
  });
});

test('current-host violations outrank intercepted handbacks and report each cause and type with newest detail', async () => {
  await withStateTree('bridge-witness-check-violation-', async (stateDir) => {
    await recordInterceptedAttempt({ stateDir, hostVersion, now: new Date(later) });
    await observe(stateDir, { detail: 'old detail' });
    await observe(stateDir, { detail: 'new detail', now: new Date(later) });
    await observe(stateDir, { cause: 'missing-ids', agentType: 'codex-scout', detail: 'ids omitted' });
    await observe(stateDir, { cause: 'missing-agent-type', agentType: null, detail: 'type omitted' });
    const record = readHandbackWitness({ stateDir });
    for (const entry of Object.values(record.ledger.entries)) assert.equal(entryState(entry), 'violation');
    const result = status(stateDir);
    assert.equal(result.state, 'violation');
    assert.match(result.message, /tools-outside-gate \/ codex-build: new detail at 2026-09-24T11:00:00/);
    assert.match(result.message, /missing-ids \/ codex-scout: ids omitted at 2026-09-24T10:00:00/);
    assert.match(result.message, /missing-agent-type: type omitted/);
    assert.doesNotMatch(result.message, /old detail/);
    assert.match(result.message, /do not trust a dispatcher answer from that time; see Plan_62 D15/);
  });
});

test('missing observation is ok and unobserved', async () => {
  await withStateTree('bridge-witness-check-empty-', async (stateDir) => {
    const result = status(stateDir, null);
    assert.equal(result.state, 'ok');
    assert.match(result.message, /only when a dispatcher runs in an interactive session/);
    assert.doesNotMatch(result.message, /History:/);
  });
});

test('intercepted handbacks on different hosts are not health signals, including unrelated patch numbers', async () => {
  await withStateTree('bridge-witness-check-other-interception-', async (stateDir) => {
    await recordInterceptedAttempt({ stateDir, hostVersion, now: new Date(at) });
    await recordInterceptedAttempt({ stateDir, hostVersion: '9.9.281', now: new Date(later) });
    for (const host of ['2.1.282', '9.9.282']) {
      const result = status(stateDir, host);
      assert.equal(result.state, 'ok');
      assert.match(result.message, /^Not observed yet/);
      assert.doesNotMatch(result.message, /stale|2026-09-24/);
    }
  });
});

test('exact host version reports its newest intercepted handback', async () => {
  await withStateTree('bridge-witness-check-intercepted-', async (stateDir) => {
    await recordInterceptedAttempt({ stateDir, hostVersion, now: new Date(at) });
    await recordInterceptedAttempt({ stateDir, hostVersion, now: new Date(later) });
    await recordInterceptedAttempt({ stateDir, hostVersion: '2.1.282', now: new Date('2026-09-25') });
    const result = status(stateDir);
    assert.equal(result.state, 'ok');
    assert.equal(result.message, `Newest intercepted handback on host ${hostVersion} at ${later}.`);
    assert.deepEqual(readHandbackWitness({ stateDir }).ledger.entries, {});
  });
});

test('a current-host violation then match is ok with one recovered history sentence', async () => {
  await withStateTree('bridge-witness-check-recovered-', async (stateDir) => {
    await observe(stateDir);
    await observe(stateDir, { verdict: 'match', detail: 'confirmed audit', now: new Date(later) });
    const entry = readHandbackWitness({ stateDir }).ledger.entries[witnessKey(options)];
    assert.equal(entryState(entry), 'recovered');
    const result = status(stateDir);
    assert.equal(result.state, 'ok');
    assert.match(result.message, /History: 1 recovered entries; 0 unresolved entries/);
    oneHistory(result.message);
  });
});

test('a violation only on another host is ok with one historical sentence', async () => {
  await withStateTree('bridge-witness-check-historical-', async (stateDir) => {
    await observe(stateDir, { hostVersion: '2.1.280' });
    const result = status(stateDir);
    assert.equal(result.state, 'ok');
    assert.match(result.message, /0 recovered entries; 1 unresolved entries on other hosts \(historical, not current\)/);
    assert.doesNotMatch(result.message, /do not trust/);
    oneHistory(result.message);
  });
});

test('13 legacy untyped alarms are ok and retained in one history sentence', async () => {
  await withStateTree('bridge-witness-check-legacy-', async (stateDir) => {
    await fs.writeFile(path.join(stateDir, WITNESS_FILE), JSON.stringify({
      lastSeen: {}, alarms: Array.from({ length: 13 }, (_, index) => ({
        hostVersion, at, detail: `host omitted agent_type for agent old-${index}`,
      })),
    }));
    assert.deepEqual(readHandbackWitness({ stateDir }).ledger.entries, {});
    const result = status(stateDir);
    assert.equal(result.state, 'ok');
    assert.match(result.message, /13 older alarms without dispatcher evidence, kept for history \(legacy-untyped-unverified\)/);
    oneHistory(result.message);
  });
});

test('legacy history counts each disposition alongside recovered and other-host entries', async () => {
  await withStateTree('bridge-witness-check-mixed-history-', async (stateDir) => {
    await fs.writeFile(path.join(stateDir, WITNESS_FILE), JSON.stringify({ lastSeen: {}, alarms: [
      { hostVersion, at, detail: 'host omitted agent_type for agent old' },
      { hostVersion, at, detail: 'unclassified old alarm' },
    ] }));
    await observe(stateDir);
    await observe(stateDir, { verdict: 'match', now: new Date(later) });
    await observe(stateDir, { hostVersion: '2.1.280' });
    const result = status(stateDir);
    assert.equal(result.state, 'ok');
    assert.match(result.message, /1 recovered entries; 1 unresolved entries/);
    assert.match(result.message, /1 older alarms without dispatcher evidence/);
    assert.match(result.message, /1 unclassified legacy entries/);
    oneHistory(result.message);
  });
});

test('a match for a different cause or type cannot hide a current-host violation', async () => {
  await withStateTree('bridge-witness-check-independent-', async (stateDir) => {
    await observe(stateDir);
    await observe(stateDir, { verdict: 'match', cause: 'missing-ids', now: new Date(later) });
    await observe(stateDir, { verdict: 'match', agentType: 'codex-scout', now: new Date(later) });
    assert.equal(status(stateDir).state, 'violation');
  });
});

test('an undetermined observation preserves the newest confirmed violation detail and time', async () => {
  await withStateTree('bridge-witness-check-undetermined-', async (stateDir) => {
    await observe(stateDir);
    await observe(stateDir, { verdict: 'undetermined', detail: 'no evidence', now: new Date(later) });
    const result = status(stateDir);
    assert.equal(result.state, 'violation');
    assert.match(result.message, /dispatcher bypassed gate at 2026-09-24T10:00:00/);
    assert.doesNotMatch(result.message, /no evidence/);
  });
});
