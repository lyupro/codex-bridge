/**
 * Plan_65 B14: purge needs evidence of absence, including stale runs and unreadable records.
 * All process identity checks are injected; these fixtures never touch the real runs root.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inspectLiveRuns, liveRunLines } from '../../cli/purge-live-runs.mjs';
import { STOP_COMMAND } from '../../src/home/lib/stop-contract.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const now = Date.parse('2026-09-25T12:00:00Z');
const startedAt = '2026-09-25T11:00:00Z';
const alive = { kill: () => {}, probe: () => startedAt, now };

function fixture(t) {
  const tree = makeTempTree('purge-live-');
  t.after(() => removeTempTree(tree));
  const root = path.join(tree, 'runs');
  fs.mkdirSync(root);
  return { tree, root };
}

function writeRun(root, project = 'project', folder = 'run', overrides = {}) {
  const runDir = path.join(root, project, folder);
  fs.mkdirSync(runDir, { recursive: true });
  const status = {
    state: 'running', pid: 12345, agent: 'codex', slug: folder,
    started_at: startedAt, process_started_at: startedAt, ...overrides,
  };
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(status));
  return runDir;
}

function inspect(root, options = {}) {
  return inspectLiveRuns({ root, ...alive, ...options });
}

function ioError(code) {
  return Object.assign(new Error(code), { code });
}

function failRead(t, method, file, code) {
  const original = fs[method];
  t.mock.method(fs, method, (candidate, ...args) => {
    if (candidate === file) throw ioError(code);
    return original(candidate, ...args);
  });
}

test('a missing runs root is clear', (t) => {
  const { tree } = fixture(t);
  const result = inspect(path.join(tree, 'missing'));
  assert.deepEqual(result, { verdict: 'clear', blocked: [], unknown: [] });
});

test('an empty runs root is clear', (t) => {
  const { root } = fixture(t);
  assert.deepEqual(inspect(root), { verdict: 'clear', blocked: [], unknown: [] });
});

test('finished runs are clear without probing their processes', (t) => {
  const { root } = fixture(t);
  writeRun(root, 'project', 'finished', { state: 'finished' });
  let probes = 0;
  const count = () => { probes += 1; return startedAt; };
  const result = inspect(root, { kill: count, probe: count });
  assert.equal(result.verdict, 'clear');
  assert.equal(probes, 0);
});

test('a run folder without the first status artifact is clear', (t) => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, 'project', 'broken'), { recursive: true });
  assert.deepEqual(inspect(root), { verdict: 'clear', blocked: [], unknown: [] });
});

test('an alive running process blocks with its run identity and quoted stop command', (t) => {
  const { root } = fixture(t);
  const runDir = writeRun(root, 'project', 'run with spaces');
  fs.writeFileSync(path.join(runDir, 'heartbeat'), 'progress');
  fs.utimesSync(path.join(runDir, 'heartbeat'), new Date(now), new Date(now));
  const result = inspect(root);
  assert.equal(result.verdict, 'blocked');
  assert.deepEqual(result.blocked, [{ runDir, agent: 'codex', slug: 'run with spaces',
    stop: `${STOP_COMMAND} "${runDir}"` }]);
  assert.deepEqual(result.unknown, []);
});

for (const heartbeat of ['stale', 'missing']) {
  test(`an alive process with a ${heartbeat} heartbeat still blocks purge`, (t) => {
    const { root } = fixture(t);
    const runDir = writeRun(root);
    if (heartbeat === 'stale') {
      const file = path.join(runDir, 'heartbeat');
      fs.writeFileSync(file, 'old progress');
      fs.utimesSync(file, new Date(now - 3_600_000), new Date(now - 3_600_000));
    }
    const result = inspect(root);
    assert.equal(result.verdict, 'blocked');
    assert.equal(result.blocked[0].runDir, runDir);
  });
}

test('a running record with an ESRCH pid is clear', (t) => {
  const { root } = fixture(t);
  writeRun(root);
  const result = inspect(root, { kill: () => { throw ioError('ESRCH'); } });
  assert.deepEqual(result, { verdict: 'clear', blocked: [], unknown: [] });
});

test('a process whose identity cannot be verified still blocks purge', (t) => {
  const { root } = fixture(t);
  writeRun(root);
  const result = inspect(root, { probe: () => null });
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.blocked.length, 1);
});

test('a reused pid judged foreign is clear', (t) => {
  const { root } = fixture(t);
  writeRun(root);
  const result = inspect(root, { probe: () => now });
  assert.equal(result.verdict, 'clear');
});

test('malformed status JSON is unknown and names the unreadable record', (t) => {
  const { root } = fixture(t);
  const runDir = writeRun(root);
  const file = path.join(runDir, 'status.json');
  fs.writeFileSync(file, '{broken');
  const result = inspect(root);
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.unknown[0].path, file);
  assert.match(result.unknown[0].reason, /JSON|parse/i);
});

for (const value of [null, [], 'running', 42, true]) {
  test(`a non-object status ${JSON.stringify(value)} is unknown`, (t) => {
    const { root } = fixture(t);
    const runDir = writeRun(root);
    const file = path.join(runDir, 'status.json');
    fs.writeFileSync(file, JSON.stringify(value));
    const result = inspect(root);
    assert.equal(result.verdict, 'unknown');
    assert.equal(result.unknown[0].path, file);
    assert.match(result.unknown[0].reason, /plain object/);
  });
}

test('BOM-prefixed JSON uses the shared file reader', (t) => {
  const { root } = fixture(t);
  const runDir = writeRun(root);
  fs.writeFileSync(path.join(runDir, 'status.json'), `\ufeff${JSON.stringify({ state: 'finished' })}`);
  assert.equal(inspect(root).verdict, 'clear');
});

test('blocked takes precedence over unknown and the complete scan keeps both lists', (t) => {
  const { root } = fixture(t);
  const first = writeRun(root, 'a-project', 'first');
  const broken = writeRun(root, 'b-project', 'broken');
  const last = writeRun(root, 'c-project', 'last');
  const another = writeRun(root, 'd-project', 'another-broken');
  fs.writeFileSync(path.join(broken, 'status.json'), '{');
  fs.writeFileSync(path.join(another, 'status.json'), 'null');
  const result = inspect(root);
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.blocked.length, 2);
  assert.equal(result.unknown.length, 2);
  assert.deepEqual(new Set(result.blocked.map((run) => run.runDir)), new Set([first, last]));
  assert.deepEqual(new Set(result.unknown.map((entry) => entry.path)),
    new Set([path.join(broken, 'status.json'), path.join(another, 'status.json')]));
});

test('a project junction is followed to its live run', (t) => {
  const { tree, root } = fixture(t);
  writeRun(tree, 'target-project', 'live');
  const link = path.join(root, 'linked-project');
  fs.symlinkSync(path.join(tree, 'target-project'), link, 'junction');
  const result = inspect(root);
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.blocked[0].runDir, path.join(link, 'live'));
});

test('a dangling project junction is skipped', (t) => {
  const { tree, root } = fixture(t);
  fs.symlinkSync(path.join(tree, 'missing-project'), path.join(root, 'dangling'), 'junction');
  assert.deepEqual(inspect(root), { verdict: 'clear', blocked: [], unknown: [] });
});

test('a run junction is followed and a dangling run junction is skipped', (t) => {
  const { tree, root } = fixture(t);
  writeRun(tree, 'target-project', 'live');
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const link = path.join(project, 'linked-run');
  fs.symlinkSync(path.join(tree, 'target-project', 'live'), link, 'junction');
  fs.symlinkSync(path.join(tree, 'missing-run'), path.join(project, 'dangling'), 'junction');
  const result = inspect(root);
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.blocked[0].runDir, link);
  assert.deepEqual(result.unknown, []);
});

test('plain files at both directory levels are ignored', (t) => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'file'), 'irrelevant');
  fs.mkdirSync(path.join(root, 'project'));
  fs.writeFileSync(path.join(root, 'project', 'file'), 'irrelevant');
  assert.equal(inspect(root).verdict, 'clear');
});

test('a regular file used as the runs root is unknown with ENOTDIR', (t) => {
  const { tree } = fixture(t);
  const file = path.join(tree, 'file-root');
  fs.writeFileSync(file, 'not a directory');
  const result = inspect(file);
  assert.equal(result.verdict, 'unknown');
  assert.deepEqual(result.unknown, [{ path: file, reason: 'ENOTDIR' }]);
});

test('an unreadable root is unknown with its path and error code', (t) => {
  const { root } = fixture(t);
  failRead(t, 'readdirSync', root, 'EACCES');
  const result = inspect(root);
  assert.equal(result.verdict, 'unknown');
  assert.deepEqual(result.unknown, [{ path: root, reason: 'EACCES' }]);
});

for (const code of ['EACCES', 'EPERM']) {
  test(`a project readdir failure ${code} is unknown and does not hide other projects`, (t) => {
    const { root } = fixture(t);
    writeRun(root, 'a-unreadable');
    writeRun(root, 'b-live');
    const project = path.join(root, 'a-unreadable');
    failRead(t, 'readdirSync', project, code);
    const result = inspect(root);
    assert.equal(result.verdict, 'blocked');
    assert.equal(result.blocked.length, 1);
    assert.deepEqual(result.unknown, [{ path: project, reason: code }]);
  });
}

test('a project folder pruned between the two listings is gone, not unknown', (t) => {
  const { root } = fixture(t);
  writeRun(root, 'a-pruned');
  const project = path.join(root, 'a-pruned');
  failRead(t, 'readdirSync', project, 'ENOENT');
  assert.deepEqual(inspect(root), { verdict: 'clear', blocked: [], unknown: [] });
});

for (const level of ['project', 'run']) {
  test(`a ${level} junction stat failure is unknown with its path and code`, (t) => {
    const { tree, root } = fixture(t);
    const target = path.join(tree, 'target');
    fs.mkdirSync(target);
    const parent = level === 'project' ? root : path.join(root, 'project');
    if (level === 'run') fs.mkdirSync(parent);
    const link = path.join(parent, 'link');
    fs.symlinkSync(target, link, 'junction');
    failRead(t, 'statSync', link, 'EACCES');
    const result = inspect(root);
    assert.equal(result.verdict, 'unknown');
    assert.deepEqual(result.unknown, [{ path: link, reason: 'EACCES' }]);
  });
}

test('an unreadable status file is unknown with its path and error code', (t) => {
  const { root } = fixture(t);
  const file = path.join(writeRun(root), 'status.json');
  failRead(t, 'readFileSync', file, 'EACCES');
  const result = inspect(root);
  assert.equal(result.verdict, 'unknown');
  assert.deepEqual(result.unknown, [{ path: file, reason: 'EACCES' }]);
});

test('clear renders no refusal lines', () => {
  assert.deepEqual(liveRunLines({ verdict: 'clear', blocked: [], unknown: [] }), []);
});

test('blocked renders each run folder and its stop command', () => {
  const runDir = path.join('runs', 'project', 'live');
  const stop = `${STOP_COMMAND} "${runDir}"`;
  const lines = liveRunLines({ verdict: 'blocked', blocked: [{ runDir, stop }], unknown: [] });
  assert.deepEqual(lines, [`Live run live: ${stop}`]);
  assert.ok(lines[0].length <= 120);
});

test('unknown renders the required fail-closed refusal text', () => {
  const lines = liveRunLines({ verdict: 'unknown', blocked: [],
    unknown: [{ path: 'runs', reason: 'EACCES' }] });
  assert.deepEqual(lines, ['Could not read runs (EACCES): purge cannot prove no run is live.']);
  assert.ok(lines[0].length <= 120);
});

test('blocked refusal lines also include every unknown finding', () => {
  const result = { verdict: 'blocked',
    blocked: [{ runDir: 'live', stop: `${STOP_COMMAND} "live"` }],
    unknown: [{ path: 'first', reason: 'EACCES' }, { path: 'second', reason: 'EIO' }] };
  const lines = liveRunLines(result);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /live/);
  assert.equal(lines[1], 'Could not read first (EACCES): purge cannot prove no run is live.');
  assert.equal(lines[2], 'Could not read second (EIO): purge cannot prove no run is live.');
});
