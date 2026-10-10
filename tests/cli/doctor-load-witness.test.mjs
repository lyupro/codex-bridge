import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withTempTree } from '../temp-tree.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { buildInstallPlan, contentFingerprint } from '../../cli/manifest.mjs';
import { plannedContent } from '../../cli/copy.mjs';
import { loadWitnessChecks } from '../../cli/doctor-load-witness.mjs';
import { LOAD_WITNESS_FILE } from '../../src/home/lib/load-witness.mjs';

const version = '2.1.1';
const earlier = '2026-10-10T12:00:00.000Z';
const later = '2026-10-10T13:00:00.000Z';

function scenario(work) {
  return withTempTree('bridge-doctor-load-witness-', async (root) => {
    // Same host construction as doctor-fixtures.mjs; no invented plan-builder fields.
    const host = resolveHost({
      host: root,
      codexHome: path.join(root, 'codex-home'),
      brandRoot: path.join(root, 'brand'),
    });
    const stateDir = path.join(host.brandRoot, 'state');
    await fs.mkdir(stateDir, { recursive: true });
    const item = (await buildInstallPlan(host)).find((entry) => path.dirname(entry.target) === host.rulesDir);
    assert.ok(item, 'the package plans a rules core');
    const sha256 = contentFingerprint(await plannedContent(item, host.brandRoot));
    const file = path.join(stateDir, LOAD_WITNESS_FILE);
    const load = (overrides = {}) => ({
      path: item.target, sha256, at: earlier, loadReason: 'session_start', memoryType: 'unreliable', ...overrides,
    });
    const session = (loads = [load()], overrides = {}) => ({
      loads, transcriptPath: path.join(root, 'session.jsonl'), cwd: root, ...overrides,
    });
    const write = (sessions) => fs.writeFile(file, JSON.stringify({ sessions }));
    const checks = async (overrides = {}) => {
      const result = await loadWitnessChecks({
        host, stateDir, record: { installedAt: earlier }, activeHosts: [version],
        readVersion: async () => version, ...overrides,
      });
      assert.ok(result.length > 0);
      assert.ok(result.every((entry) => ['ok', 'warn'].includes(entry.status)), 'load evidence never fails');
      return result;
    };
    return work({ root, host, stateDir, file, load, session, write, checks });
  });
}

test('credits exact target and packaged hash on an active version without comparing metadata', async () => {
  await scenario(async ({ session, write, checks }) => {
    await write({ witness: session(undefined, { entrypoint: 'unreliable' }) });
    const rows = await checks();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, `claudeRulesLoad:${version}`);
    assert.equal(rows[0].status, 'ok');
    assert.equal(rows[0].value, `rules core load witnessed (1 session(s), latest ${earlier})`);
  });
});

test('passes the witness session id to the injected reader and never credits another session', async () => {
  await scenario(async ({ session, write, checks }) => {
    const entry = session();
    await write({ witness: entry });
    const calls = [];
    const rows = await checks({ readVersion: async (transcriptPath, options) => {
      calls.push({ transcriptPath, options });
      return options.sessionId === 'other' ? version : null;
    } });
    assert.deepEqual(calls, [{ transcriptPath: entry.transcriptPath, options: { sessionId: 'witness' } }]);
    assert.equal(rows[0].status, 'warn');
    assert.match(rows[0].value, /1 session\(s\) awaiting their transcript/);
  });
});

test('default reader rejects a neighboring session and later accepts the matching session', async () => {
  await scenario(async ({ session, write, checks }) => {
    const entry = session();
    await write({ witness: entry });
    await fs.writeFile(entry.transcriptPath, JSON.stringify({ sessionId: 'other', version }) + '\n');
    const pending = await checks({ readVersion: undefined });
    assert.equal(pending[0].status, 'warn');
    assert.match(pending[0].value, /awaiting their transcript/);
    await fs.appendFile(entry.transcriptPath, JSON.stringify({ sessionId: 'witness', version }) + '\n');
    await fs.appendFile(entry.transcriptPath, JSON.stringify({ sessionId: 'other', version: '9.9.9' }) + '\n');
    const verified = await checks({ readVersion: undefined });
    assert.equal(verified[0].status, 'ok');
    assert.equal(verified[0].key, `claudeRulesLoad:${version}`);
  });
});

test('emits one row per active version and does not inherit evidence across versions', async () => {
  await scenario(async ({ session, write, checks }) => {
    await write({ witness: session() });
    const rows = await checks({ activeHosts: [version, '2.1.2', version] });
    assert.deepEqual(rows.map(({ key, status }) => ({ key, status })), [
      { key: `claudeRulesLoad:${version}`, status: 'ok' },
      { key: 'claudeRulesLoad:2.1.2', status: 'warn' },
    ]);
    assert.equal(rows[1].value, 'no session on host 2.1.2 has witnessed the rules core loading yet; open a new Claude Code session, then rerun codex-bridge doctor');
  });
});

test('a wrong hash warns that the witnessed core is stale', async () => {
  await scenario(async ({ load, session, write, checks }) => {
    await write({ witness: session([load({ sha256: '0'.repeat(64) })]) });
    const rows = await checks();
    assert.equal(rows[0].status, 'warn');
    assert.match(rows[0].value, /witnessed core differs from this package \(stale\)/);
  });
});

test('a newest stale load overrides earlier valid evidence regardless of state entry order', async () => {
  await scenario(async ({ load, session, write, checks }) => {
    await write({ stale: session([load({ sha256: 'wrong', at: later })]), verified: session() });
    const rows = await checks();
    assert.equal(rows[0].status, 'warn');
    assert.match(rows[0].value, /stale/);
  });
});

test('a newest valid load restores evidence and counts distinct qualifying sessions', async () => {
  await scenario(async ({ load, session, write, checks }) => {
    await write({
      stale: session([load({ sha256: 'wrong', at: '2026-10-10T11:00:00.000Z' })]),
      first: session([load(), load({ at: later })]),
      second: session(),
    });
    const rows = await checks();
    assert.equal(rows[0].status, 'ok');
    assert.equal(rows[0].value, `rules core load witnessed (2 session(s), latest ${later})`);
  });
});

test('the right hash at another root is not evidence and is not pending', async () => {
  await scenario(async ({ root, load, session, write, checks }) => {
    await write({ witness: session([load({ path: path.join(root, 'other', 'rules', 'codex-bridge', 'core.md') })]) });
    let calls = 0;
    const rows = await checks({ readVersion: async () => { calls += 1; return version; } });
    assert.equal(rows[0].status, 'warn');
    assert.equal(calls, 0);
    assert.doesNotMatch(rows[0].value, /awaiting|stale/);
  });
});

test('lexically normalizes dot segments without requiring an installed file or realpath', async () => {
  await scenario(async ({ load, session, write, checks }) => {
    const target = load().path;
    const lexical = `${path.dirname(target)}${path.sep}absent${path.sep}..${path.sep}${path.basename(target)}`;
    await write({ witness: session([load({ path: lexical })]) });
    assert.equal((await checks())[0].status, 'ok');
  });
});

test('accepts forward slash spelling and folds path case only on win32', async () => {
  await scenario(async ({ load, session, write, checks }) => {
    const slashPath = load().path.replaceAll('\\', '/');
    await write({ witness: session([load({ path: slashPath })]) });
    assert.equal((await checks())[0].status, 'ok');
    await write({ witness: session([load({ path: slashPath.toUpperCase() })]) });
    assert.equal((await checks())[0].status, process.platform === 'win32' ? 'ok' : 'warn');
    if (process.platform === 'win32') {
      await write({ witness: session([load({ path: slashPath.toUpperCase().replaceAll('/', '\\') })]) });
      assert.equal((await checks())[0].status, 'ok');
    }
  });
});

test('pending transcripts warn and count sessions rather than loads', async () => {
  await scenario(async ({ load, session, write, checks }) => {
    await write({ first: session([load(), load({ at: later })]), second: session() });
    const rows = await checks({ readVersion: async () => null });
    assert.equal(rows[0].status, 'warn');
    assert.match(rows[0].value, /\(2 session\(s\) awaiting their transcript\)/);
  });
});

test('pending transcripts add a note to verified rows too', async () => {
  await scenario(async ({ session, write, checks }) => {
    await write({ verified: session(), pending: session() });
    const rows = await checks({ readVersion: async (_, { sessionId }) => sessionId === 'verified' ? version : null });
    assert.equal(rows[0].status, 'ok');
    assert.match(rows[0].value, /\(1 session\(s\) awaiting their transcript\)/);
  });
});

test('missing evidence only warns for each active version', async () => {
  await scenario(async ({ checks }) => {
    const rows = await checks({ activeHosts: [version, '2.1.2'] });
    assert.equal(rows.length, 2);
    assert.ok(rows.every(({ status }) => status === 'warn'));
    assert.doesNotMatch(rows[0].value, /stale|awaiting/);
  });
});

test('no active hosts and no evidence produce one generic warning', async () => {
  await scenario(async ({ checks }) => {
    const rows = await checks({ activeHosts: [] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, 'claudeRulesLoad');
    assert.equal(rows[0].status, 'warn');
    assert.equal(rows[0].value, 'no session has witnessed the rules core loading yet; open a new Claude Code session');
  });
});

test('no active hosts produce a verified row for each witnessed version', async () => {
  await scenario(async ({ session, write, checks }) => {
    await write({ first: session(), second: session() });
    const rows = await checks({ activeHosts: [], readVersion: async (_, { sessionId }) => sessionId === 'first' ? version : '2.1.2' });
    assert.deepEqual(rows.map(({ key, status }) => ({ key, status })), [
      { key: `claudeRulesLoad:${version}`, status: 'ok' },
      { key: 'claudeRulesLoad:2.1.2', status: 'ok' },
    ]);
  });
});

test('stale-only evidence with no active hosts never creates a verified row', async () => {
  await scenario(async ({ load, session, write, checks }) => {
    await write({ witness: session([load({ sha256: 'wrong' })]) });
    const rows = await checks({ activeHosts: [] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, 'claudeRulesLoad');
    assert.equal(rows[0].status, 'warn');
  });
});

test('pending transcripts remain visible without active hosts', async () => {
  await scenario(async ({ session, write, checks }) => {
    await write({ witness: session() });
    const rows = await checks({ activeHosts: [], readVersion: async () => null });
    assert.equal(rows[0].status, 'warn');
    assert.match(rows[0].value, /awaiting their transcript/);
  });
});

test('corrupt witness state warns once and names the file', async () => {
  await scenario(async ({ file, checks }) => {
    for (const content of ['{broken', JSON.stringify({ sessions: [] })]) {
      await fs.writeFile(file, content);
      const rows = await checks();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].key, 'claudeRulesLoad');
      assert.equal(rows[0].status, 'warn');
      assert.ok(rows[0].value.includes(file));
    }
  });
});

test('before installation returns one warning without inspecting corrupt state', async () => {
  await scenario(async ({ file, checks }) => {
    await fs.writeFile(file, '{broken');
    const rows = await checks({ record: null, host: null });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, 'claudeRulesLoad');
    assert.equal(rows[0].status, 'warn');
    assert.equal(rows[0].value, 'not checked before installation');
  });
});

test('malformed session and load entries do not invent evidence or crash doctor', async () => {
  await scenario(async ({ write, checks }) => {
    await write({ missing: {}, nullSession: null, malformed: { loads: [null, {}, { path: 42 }] } });
    assert.equal((await checks())[0].status, 'warn');
  });
});

test('wrong-hash loads awaiting a version do not count as pending evidence', async () => {
  await scenario(async ({ load, session, write, checks }) => {
    await write({ witness: session([load({ sha256: 'wrong' })]) });
    const rows = await checks({ readVersion: async () => null });
    assert.equal(rows[0].status, 'warn');
    assert.doesNotMatch(rows[0].value, /awaiting their transcript/);
  });
});
