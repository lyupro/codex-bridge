import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { HOOK_DEFINITIONS } from '../../src/home/lib/hook-definitions.mjs';
import {
  LOAD_WITNESS_FILE, isCoreLoadCandidate, readLoadWitness, recordCoreLoad,
} from '../../src/home/lib/load-witness.mjs';
import { withTempTree } from '../temp-tree.mjs';

const now = new Date('2026-10-10T12:00:00.000Z');
const hook = fileURLToPath(new URL('../../src/home/hooks/load-witness.mjs', import.meta.url));
const event = (filePath, overrides = {}) => ({
  hook_event_name: 'InstructionsLoaded', load_reason: 'session_start', session_id: 'session-1',
  file_path: filePath, transcript_path: 'not-yet-created.jsonl', cwd: 'host-project',
  memory_type: 'Project', ignored_future_field: 'ignored', ...overrides,
});

async function fixture(root) {
  const stateDir = path.join(root, 'state');
  const core = path.join(root, '.claude', 'rules', 'codex-bridge', 'core.md');
  const bytes = Buffer.from('Rules core\r\n\u00e9\n');
  await fs.mkdir(path.dirname(core), { recursive: true });
  await fs.writeFile(core, bytes);
  return { stateDir, core, bytes };
}

test('D11 registers an observing InstructionsLoaded hook', () => {
  assert.deepEqual(HOOK_DEFINITIONS.find(({ name }) => name === 'load-witness'), {
    name: 'load-witness', event: 'InstructionsLoaded', matcher: '*', file: 'load-witness.mjs',
  });
});

test('core candidates accept Windows and forward slashes case-insensitively', () => {
  assert.equal(isCoreLoadCandidate('C:\\host\\.claude\\RULES\\CODEX-BRIDGE\\CORE.MD'), true);
  assert.equal(isCoreLoadCandidate('/host/.claude/rules/codex-bridge/core.md'), true);
  for (const candidate of [null, 4, '', '/rules/codex-bridge/core.md.bak', '/rules/other/core.md']) {
    assert.equal(isCoreLoadCandidate(candidate), false);
  }
});

test('records exact bytes and paths before the transcript exists, once per session path', async () => {
  await withTempTree('load-witness-record-', async (root) => {
    const { stateDir, core, bytes } = await fixture(root);
    assert.deepEqual(readLoadWitness({ stateDir }), { sessions: {} });
    assert.deepEqual(await recordCoreLoad({ stateDir, input: event(core), now }), { recorded: true });
    const expected = {
      transcriptPath: 'not-yet-created.jsonl', cwd: 'host-project', loads: [{
        path: core, loadReason: 'session_start', memoryType: 'Project',
        sha256: createHash('sha256').update(bytes).digest('hex'), at: now.toISOString(),
      }],
    };
    assert.deepEqual(readLoadWitness({ stateDir }), { sessions: { 'session-1': expected } });
    assert.equal((await recordCoreLoad({ stateDir, now, input: event(core, {
      cwd: 'different-project', transcript_path: 'other.jsonl',
    }) })).recorded, false);
    assert.deepEqual(readLoadWitness({ stateDir }).sessions['session-1'], expected);
    await recordCoreLoad({ stateDir, now, input: event(core, { session_id: 'session-2', memory_type: undefined }) });
    assert.equal(readLoadWitness({ stateDir }).sessions['session-2'].loads[0].memoryType, null);
    const otherCore = path.join(root, 'another-host', 'rules', 'codex-bridge', 'core.md');
    await recordCoreLoad({ stateDir, now, input: event(otherCore) });
    assert.equal(readLoadWitness({ stateDir }).sessions['session-1'].loads.length, 2);
  });
});

test('ignores other load reasons, events, files and missing identifiers without touching state', async () => {
  await withTempTree('load-witness-ignore-', async (root) => {
    const stateDir = path.join(root, 'state');
    const core = '/host/rules/codex-bridge/core.md';
    for (const input of [
      null, [], 'string', event(core, { load_reason: 'compact' }),
      event(core, { load_reason: 'nested_traversal' }), event(core, { hook_event_name: 'SessionStart' }),
      event('/host/rules/other.md'), event(core, { session_id: undefined }),
      event(core, { session_id: '' }), event(core, { session_id: ' ' }),
      event(core, { file_path: undefined }), event(core, { file_path: '' }),
    ]) {
      const result = await recordCoreLoad({ stateDir, input, readFile: () => assert.fail('must not read core') });
      assert.equal(result.recorded, false);
      assert.equal(typeof result.reason, 'string');
    }
    await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
  });
});

test('unreadable core records a null hash and the read error code', async () => {
  await withTempTree('load-witness-read-error-', async (root) => {
    const stateDir = path.join(root, 'state');
    const core = path.join(root, 'rules', 'codex-bridge', 'core.md');
    await recordCoreLoad({ stateDir, now, input: event(core) });
    let load = readLoadWitness({ stateDir }).sessions['session-1'].loads[0];
    assert.equal(load.sha256, null);
    assert.equal(load.readError, 'ENOENT');
    await recordCoreLoad({ stateDir, now, input: event(core, { session_id: 'denied' }),
      readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    });
    load = readLoadWitness({ stateDir }).sessions.denied.loads[0];
    assert.equal(load.sha256, null);
    assert.equal(load.readError, 'EACCES');
  });
});

test('each write prunes by the newest load, keeping the exact 30-day boundary', async () => {
  await withTempTree('load-witness-prune-', async (root) => {
    const { stateDir, core } = await fixture(root);
    await fs.mkdir(stateDir);
    const load = (at) => ({ path: core, at });
    await fs.writeFile(path.join(stateDir, LOAD_WITNESS_FILE), JSON.stringify({ sessions: {
      stale: { loads: [load('2026-09-10T11:59:59.999Z')] },
      boundary: { loads: [load('2026-09-10T12:00:00.000Z')] },
      newest: { loads: [load('2026-10-09T00:00:00Z'), load('2026-01-01T00:00:00Z')] },
    } }));
    await recordCoreLoad({ stateDir, now, input: event(core) });
    let sessions = readLoadWitness({ stateDir }).sessions;
    assert.deepEqual(Object.keys(sessions).sort(), ['boundary', 'newest', 'session-1']);
    await recordCoreLoad({ stateDir, now: new Date('2026-10-11T12:00:00Z'), input: event(core) });
    sessions = readLoadWitness({ stateDir }).sessions;
    assert.deepEqual(Object.keys(sessions).sort(), ['newest', 'session-1']);
    assert.equal(sessions['session-1'].loads.length, 1);
  });
});

test('a session row without a loads array is dropped instead of blocking every later witness', async () => {
  await withTempTree('load-witness-bad-row-', async (root) => {
    const { stateDir, core } = await fixture(root);
    await fs.mkdir(stateDir);
    await fs.writeFile(path.join(stateDir, LOAD_WITNESS_FILE), JSON.stringify({ sessions: {
      edited: { transcriptPath: 'x.jsonl' }, empty: null,
    } }));
    assert.deepEqual(await recordCoreLoad({ stateDir, now, input: event(core) }), { recorded: true });
    assert.deepEqual(Object.keys(readLoadWitness({ stateDir }).sessions), ['session-1']);
  });
});

test('corrupt or unreadable state is reported and never overwritten', async () => {
  await withTempTree('load-witness-corrupt-', async (root) => {
    const { stateDir, core } = await fixture(root);
    await fs.mkdir(stateDir);
    const file = path.join(stateDir, LOAD_WITNESS_FILE);
    for (const raw of ['{broken', 'null', '[]', '{}', '{"sessions":[]}', '{"sessions":null}']) {
      await fs.writeFile(file, raw);
      assert.deepEqual(readLoadWitness({ stateDir }), { sessions: {}, corrupt: true });
      await assert.rejects(recordCoreLoad({ stateDir, now, input: event(core) }), /corrupt load witness/);
      assert.deepEqual(await fs.readFile(file), Buffer.from(raw));
    }
    const unreadableDir = path.join(root, 'unreadable-home', 'state');
    await fs.mkdir(path.join(unreadableDir, LOAD_WITNESS_FILE), { recursive: true });
    assert.deepEqual(readLoadWitness({ stateDir: unreadableDir }), { sessions: {}, corrupt: true });
    await assert.rejects(recordCoreLoad({ stateDir: unreadableDir, now, input: event(core) }), /corrupt load witness/);
    assert.equal((await fs.stat(path.join(unreadableDir, LOAD_WITNESS_FILE))).isDirectory(), true);
  });
});

test('concurrent sessions survive the shared lock without lost updates', async () => {
  await withTempTree('load-witness-concurrent-', async (root) => {
    const { stateDir, core } = await fixture(root);
    await Promise.all(['first', 'second', '__proto__'].map((session_id) =>
      recordCoreLoad({ stateDir, now, input: event(core, { session_id }) })));
    assert.deepEqual(Object.keys(readLoadWitness({ stateDir }).sessions).sort(), ['__proto__', 'first', 'second']);
  });
});

test('hook child is quiet for dry runs, malformed inputs, valid events and writer failures', async () => {
  await withTempTree('load-witness-hook-', async (root) => {
    const { core, bytes } = await fixture(root);
    const home = path.join(root, 'brand-home');
    const stateDir = path.join(home, 'state');
    const run = (input) => {
      const result = spawnSync(process.execPath, [hook], {
        input, encoding: 'utf8', timeout: 5_000,
        env: { ...process.env, CODEX_BRIDGE_HOME: home },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    };
    for (const input of ['', '   ', '{invalid', 'null', '[]', '"text"']) run(input);
    await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
    run(JSON.stringify(event(core)));
    const load = readLoadWitness({ stateDir }).sessions['session-1'].loads[0];
    assert.equal(load.path, core);
    assert.equal(load.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(readLoadWitness({ stateDir }).sessions['session-1'].transcriptPath, 'not-yet-created.jsonl');
    const file = path.join(stateDir, LOAD_WITNESS_FILE);
    await fs.writeFile(file, '{broken');
    run(JSON.stringify(event(core, { session_id: 'another-session' })));
    assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  });
});
