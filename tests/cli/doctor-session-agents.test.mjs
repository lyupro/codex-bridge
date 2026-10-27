/** Guards OW-071: disk installation must not stand in for a session's loaded dispatcher listing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { sessionAgentsCheck } from '../../cli/doctor-session-agents.mjs';
import { diagnose } from '../../cli/doctor.mjs';
import { AGENTS } from '../../src/home/lib/agents.mjs';
import { brandStateDir } from '../../src/home/lib/brand-home.mjs';
import { LOAD_WITNESS_FILE } from '../../src/home/lib/load-witness.mjs';
import { codexProbe, installedFixture, ownPackage, runsRootFixture } from './doctor-fixtures.mjs';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const CUTOFF = NOW - 9 * 24 * 60 * 60 * 1000;
const freshStat = () => ({ mtimeMs: NOW });
const scope = (verified, unknown, skipped) => `transcript modified within the last 9 days: ${verified} verified complete; `
  + `${unknown} not verifiable; ${skipped} skipped (older than 9 days or transcript unavailable; not assessed)`;

async function transcriptFixture(stateDir, { healthy = false, initialOnly = false } = {}) {
  const name = healthy ? 'claude-2.1.310-agent-listing-healthy.jsonl' : 'claude-2.1.304-agent-listing-late.jsonl';
  const text = await fs.readFile(new URL(`../meta/fixtures/${name}`, import.meta.url), 'utf8');
  const records = text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const initialIndex = records.findIndex((entry) => entry.attachment?.isInitial);
  const selected = initialOnly ? records.slice(0, initialIndex + 1) : records;
  const sessionId = records[0].sessionId;
  const transcriptPath = path.join(stateDir, `${sessionId}.jsonl`);
  await fs.writeFile(transcriptPath, selected.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const observedAt = selected.filter((entry) => entry.attachment?.type === 'agent_listing_delta').at(-1).timestamp;
  return { sessionId, transcriptPath, observedAt };
}

async function writeWitness(stateDir, sessions) {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, LOAD_WITNESS_FILE), JSON.stringify({ sessions }));
}

function witnessed(fixture, cwd) {
  return { loads: [], transcriptPath: fixture.transcriptPath, ...(cwd ? { cwd } : {}) };
}

test('initial late listing warns with session, cwd, listing time and every missing dispatcher', async () => {
  const stateDir = makeTempTree('doctor-session-agents-');
  const fixture = await transcriptFixture(stateDir, { initialOnly: true });
  await writeWitness(stateDir, { [fixture.sessionId]: witnessed(fixture, 'C:/project') });
  const row = await sessionAgentsCheck({ stateDir });
  assert.equal(row.key, 'sessionAgents');
  assert.equal(row.status, 'warn');
  assert.ok(row.value.includes(fixture.sessionId.slice(0, 8)));
  assert.ok(row.value.includes('C:/project'));
  assert.ok(row.value.includes(fixture.observedAt));
  for (const name of Object.keys(AGENTS)) assert.ok(row.value.includes(name));
  assert.ok(row.value.endsWith(scope(0, 0, 0)));
  assert.ok(row.value.includes(`restart that window if it is still open; ${scope(0, 0, 0)}`));
});

for (const healthy of [false, true]) {
  test(`${healthy ? 'healthy initial' : 'full late'} listing confirms all dispatchers`, async () => {
    const stateDir = makeTempTree('doctor-session-agents-');
    const fixture = await transcriptFixture(stateDir, { healthy });
    await writeWitness(stateDir, { [fixture.sessionId]: witnessed(fixture) });
    assert.deepEqual(await sessionAgentsCheck({ stateDir }), {
      key: 'sessionAgents', status: 'ok',
      value: scope(1, 0, 0),
    });
  });
}

test('missing transcript is not verifiable and never counted as absence or verified', async () => {
  const stateDir = makeTempTree('doctor-session-agents-');
  await writeWitness(stateDir, { 'missing-session': { loads: [], transcriptPath: path.join(stateDir, 'missing.jsonl') } });
  const row = await sessionAgentsCheck({ stateDir, now: NOW, stat: freshStat });
  assert.equal(row.status, 'ok');
  assert.equal(row.value, scope(0, 1, 0));
  assert.doesNotMatch(row.value, /missing-session|restart|absent/);
});

test('corrupt witness warns with its exact file path', async () => {
  const stateDir = makeTempTree('doctor-session-agents-');
  const file = path.join(stateDir, LOAD_WITNESS_FILE);
  await fs.writeFile(file, '{broken');
  const row = await sessionAgentsCheck({ stateDir });
  assert.equal(row.status, 'warn');
  assert.ok(row.value.includes(file));
});

test('empty witness warns that no session has been recorded', async () => {
  const stateDir = makeTempTree('doctor-session-agents-');
  await writeWitness(stateDir, {});
  assert.deepEqual(await sessionAgentsCheck({ stateDir }), {
    key: 'sessionAgents', status: 'warn', value: 'no recorded session yet',
  });
});

test('missing witness warns that no session has been recorded', async () => {
  const stateDir = makeTempTree('doctor-session-agents-');
  assert.equal((await sessionAgentsCheck({ stateDir })).value, 'no recorded session yet');
});

test('mixed absent, healthy and skipped sessions name only the absent session', async () => {
  const stateDir = makeTempTree('doctor-session-agents-');
  const absent = await transcriptFixture(stateDir, { initialOnly: true });
  const healthy = await transcriptFixture(stateDir, { healthy: true });
  await writeWitness(stateDir, {
    [absent.sessionId]: witnessed(absent), [healthy.sessionId]: witnessed(healthy, 'healthy-cwd'),
    'skipped-session': { transcriptPath: 'old', cwd: 'skipped-cwd' },
  });
  const calls = [];
  const { sessionAgentTypes } = await import('../../src/home/lib/agent-listing.mjs');
  const row = await sessionAgentsCheck({ stateDir, now: NOW,
    stat: (file) => ({ mtimeMs: file === 'old' ? CUTOFF - 1 : NOW }),
    readListing: (options) => {
      calls.push(options.sessionId);
      return sessionAgentTypes(options);
    },
  });
  assert.deepEqual(calls, [absent.sessionId, healthy.sessionId]);
  assert.equal(row.status, 'warn');
  assert.ok(row.value.includes(absent.sessionId.slice(0, 8)));
  assert.ok(!row.value.includes(healthy.sessionId.slice(0, 8)));
  assert.doesNotMatch(row.value, /healthy-cwd|skipped-session|skipped-cwd/);
  assert.ok(row.value.endsWith(scope(1, 0, 1)));
});

test('unknown and failed listing reads are counted separately while proven absence stays visible', async () => {
  const stateDir = makeTempTree('doctor-session-agents-');
  const absent = await transcriptFixture(stateDir, { initialOnly: true });
  await writeWitness(stateDir, {
    'unknown-session': { transcriptPath: 'unknown' },
    'failed-session': { transcriptPath: 'failed' },
    [absent.sessionId]: witnessed(absent),
  });
  const { sessionAgentTypes } = await import('../../src/home/lib/agent-listing.mjs');
  const calls = [];
  const row = await sessionAgentsCheck({ stateDir, now: NOW, stat: freshStat, readListing: async (options) => {
    calls.push(options.sessionId);
    if (options.transcriptPath === 'failed') throw new Error('read failed');
    if (options.transcriptPath === 'unknown') return { state: 'unknown', reason: 'no-listing-record' };
    return sessionAgentTypes(options);
  } });
  assert.equal(row.status, 'warn');
  assert.ok(row.value.includes(absent.sessionId.slice(0, 8)));
  assert.deepEqual(calls, ['unknown-session', 'failed-session', absent.sessionId]);
  assert.ok(row.value.endsWith(scope(0, 2, 0)));
  assert.doesNotMatch(row.value, /unknown-session|failed-session/);
});

test('sessions without a string transcript path are skipped without stat or replay', async () => {
  const stateDir = makeTempTree('doctor-session-agents-');
  await writeWitness(stateDir, { 'no-path': { loads: [] }, 'null-session': null,
    'numeric-path': { transcriptPath: 42 } });
  const calls = [];
  const stats = [];
  const row = await sessionAgentsCheck({ stateDir, now: NOW,
    stat: (file) => { stats.push(file); return freshStat(); },
    readListing: (options) => { calls.push(options.sessionId); },
  });
  assert.deepEqual(stats, []);
  assert.deepEqual(calls, []);
  assert.equal(row.status, 'warn');
  assert.equal(row.value, `no sessions were assessed; ${scope(0, 0, 3)}`);
});

test('all present plus unknown sessions count only proven complete listings', async () => {
  const stateDir = makeTempTree('doctor-session-agents-');
  const healthy = await transcriptFixture(stateDir, { healthy: true });
  await writeWitness(stateDir, {
    [healthy.sessionId]: witnessed(healthy), 'unknown-session': { transcriptPath: path.join(stateDir, 'gone.jsonl') },
  });
  const row = await sessionAgentsCheck({ stateDir, now: NOW, stat: freshStat });
  assert.equal(row.status, 'ok');
  assert.equal(row.value, scope(1, 1, 0));
});

test('absent sessions are ordered by newest listing and name only dispatchers actually missing', async () => {
  const stateDir = makeTempTree('doctor-session-agents-');
  await writeWitness(stateDir, {
    'older-session': { transcriptPath: 'older' }, 'newer-session': { transcriptPath: 'newer' },
  });
  const row = await sessionAgentsCheck({ stateDir, now: NOW, stat: freshStat, readListing: ({ sessionId, transcriptPath }) => {
    assert.equal(sessionId, `${transcriptPath}-session`);
    return { state: 'known', types: Object.keys(AGENTS).filter((name) => name !== 'codex-build'),
      observedAt: transcriptPath === 'newer' ? '2026-10-26T12:00:00Z' : '2026-10-21T12:00:00Z' };
  } });
  assert.equal(row.status, 'warn');
  assert.ok(row.value.indexOf('newer-se') < row.value.indexOf('older-se'));
  assert.match(row.value, /codex-build/);
  assert.doesNotMatch(row.value, /codex-scout|codex-review|codex-advisor/);
});

test('cutoff mtime is assessed inclusively and one millisecond older is never replayed', async () => {
  const stateDir = makeTempTree('doctor-session-agents-');
  await writeWitness(stateDir, {
    'at-cutoff': { transcriptPath: 'boundary' }, 'before-cutoff': { transcriptPath: 'older' },
  });
  const calls = [];
  const stats = [];
  const row = await sessionAgentsCheck({ stateDir, now: NOW,
    stat: (file) => { stats.push(file); return { mtimeMs: file === 'boundary' ? CUTOFF : CUTOFF - 1 }; },
    readListing: (options) => {
      calls.push(options);
      return { state: 'known', types: Object.keys(AGENTS) };
    },
  });
  assert.deepEqual(stats, ['boundary', 'older']);
  assert.deepEqual(calls, [{ transcriptPath: 'boundary', sessionId: 'at-cutoff' }]);
  assert.equal(row.status, 'ok');
  assert.equal(row.value, scope(1, 0, 1));
});

for (const [label, metadata] of [
  ['old witness load time', { loads: [{ at: '2025-01-01T00:00:00Z' }] }],
  ['different cwd', { cwd: path.resolve(process.cwd(), '..', 'another-project') }],
]) {
  test('fresh transcript with ' + label + ' is assessed', async () => {
    const stateDir = makeTempTree('doctor-session-agents-');
    await writeWitness(stateDir, { eligible: { ...metadata, transcriptPath: 'fresh' } });
    const calls = [];
    const row = await sessionAgentsCheck({ stateDir, now: NOW, stat: freshStat,
      readListing: (options) => {
        calls.push(options);
        return { state: 'known', types: Object.keys(AGENTS) };
      },
    });
    assert.deepEqual(calls, [{ transcriptPath: 'fresh', sessionId: 'eligible' }]);
    assert.equal(row.status, 'ok');
    assert.equal(row.value, scope(1, 0, 0));
  });
}

test('more than ten eligible sessions are all assessed', async () => {
  const stateDir = makeTempTree('doctor-session-agents-');
  const sessions = Object.fromEntries(Array.from({ length: 12 }, (_, index) =>
    ['session-' + index, { transcriptPath: 'transcript-' + index }]));
  await writeWitness(stateDir, sessions);
  const calls = [];
  const row = await sessionAgentsCheck({ stateDir, now: NOW, stat: freshStat,
    readListing: (options) => {
      calls.push(options);
      return { state: 'known', types: Object.keys(AGENTS) };
    },
  });
  assert.deepEqual(calls, Object.entries(sessions).map(([sessionId, session]) =>
    ({ sessionId, transcriptPath: session.transcriptPath })));
  assert.equal(row.status, 'ok');
  assert.equal(row.value, scope(12, 0, 0));
});

test('all old transcripts warn that no sessions were assessed without replay', async () => {
  const stateDir = makeTempTree('doctor-session-agents-');
  await writeWitness(stateDir, {
    older: { transcriptPath: 'older', loads: [{ at: new Date(NOW).toISOString() }] },
    oldest: { transcriptPath: 'oldest' },
  });
  const calls = [];
  const row = await sessionAgentsCheck({ stateDir, now: NOW, stat: () => ({ mtimeMs: CUTOFF - 1 }),
    readListing: (options) => { calls.push(options.sessionId); },
  });
  assert.deepEqual(calls, []);
  assert.equal(row.status, 'warn');
  assert.equal(row.value, 'no sessions were assessed; ' + scope(0, 0, 2));
});

test('stat failure skips the unavailable transcript without replay', async () => {
  const stateDir = makeTempTree('doctor-session-agents-');
  await writeWitness(stateDir, { unavailable: { transcriptPath: 'unreadable' } });
  const calls = [];
  const stats = [];
  const row = await sessionAgentsCheck({ stateDir, now: NOW,
    stat: (file) => { stats.push(file); throw new Error('stat failed'); },
    readListing: (options) => { calls.push(options.sessionId); },
  });
  assert.deepEqual(stats, ['unreadable']);
  assert.deepEqual(calls, []);
  assert.equal(row.status, 'warn');
  assert.equal(row.value, 'no sessions were assessed; ' + scope(0, 0, 1));
});

test('a sessionAgents warning follows agents and leaves diagnose exit code at zero', async (t) => {
  const { host } = await installedFixture(t);
  await runsRootFixture(t);
  const stateDir = brandStateDir(host.brandRoot);
  await fs.mkdir(stateDir, { recursive: true });
  const fixture = await transcriptFixture(stateDir, { initialOnly: true });
  await writeWitness(stateDir, { [fixture.sessionId]: witnessed(fixture) });
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage,
    bridgeProbe: () => ({ available: true, value: 'codex-bridge test' }),
    launcherProbe: () => ({ ok: true }),
  });
  const agentsIndex = result.checks.findIndex((row) => row.key === 'agents');
  assert.equal(result.checks[agentsIndex + 1].key, 'sessionAgents');
  assert.equal(result.checks[agentsIndex + 1].status, 'warn');
  assert.ok(result.checks[agentsIndex + 1].value.includes(fixture.sessionId.slice(0, 8)));
  assert.equal(result.exitCode, 0);
});
