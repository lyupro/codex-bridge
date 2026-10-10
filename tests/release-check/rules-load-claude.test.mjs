/** Guards fake-only hardened sessions and release verdicts because Plan_64 D13/D14 forbid spending host quota in automated tests. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempTree } from '../temp-tree.mjs';
import { test } from 'node:test';
import { readJsonFile } from '../../src/home/lib/json-file.mjs';
import { writeAttempt, DEFAULT_ATTEMPT_PATH } from '../../scripts/release-check/rules-load-verdict.mjs';
import { isolatedEnv } from '../../scripts/release-check/rules-load-isolation.mjs';
import { preflightTarget, REQUIRED_FLAGS } from '../../scripts/release-check/rules-load-targets.mjs';
import { runSession, awaitWitness } from '../../scripts/release-check/rules-load-session.mjs';
import { main } from '../../scripts/release-check/rules-load-claude.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const version = '2.1.999';
const model = 'fixture-model';
const sha256 = 'a'.repeat(64);

function fixture() {
  const calls = { sessions: [], removed: [], created: [], stdout: [], stderr: [], attempts: [], preflight: [] };
  const targets = Object.fromEntries(['cli', 'vscode'].map((role) => [role, { role, executable: path.resolve('fake-host', `${role}.exe`) }]));
  const trees = {};
  let sequence = 0;
  const deps = {
    repositoryRoot, tmpRoot: path.join(repositoryRoot, 'fake-tmp'), realStateDir: path.join(repositoryRoot, 'fake-real', 'state'),
    env: { PATH: 'fixture-path', CLAUDE_CODE_ENTRYPOINT: 'vscode', CLAUDE_CODE_EXECPATH: targets.vscode.executable },
    now: () => 1_700_000_000_000, randomUUID: () => `uuid-${++sequence}`,
    stdout: (line) => calls.stdout.push(line), stderr: (line) => calls.stderr.push(line),
    realStateSentinel: ({ env }) => { assert.equal(env.CLAUDE_CODE_ENTRYPOINT, 'vscode'); return { record: 'stable' }; },
    resolveTargets: ({ env, vscodeExecutable }) => { assert.equal(env.CLAUDE_CODE_EXECPATH, deps.env.CLAUDE_CODE_EXECPATH); calls.vscodeExecutable = vscodeExecutable; return targets; },
    run: () => { throw new Error('Unexpected process runner call'); },
    preflightTarget,
    preflightRun: (executable, args, options) => {
      calls.preflight.push({ executable, args, options });
      return { status: 0, stdout: args[0] === '--version' ? version : REQUIRED_FLAGS.join('\n') };
    },
    createRoleTree: ({ role, tmpRoot }) => {
      calls.created.push(role);
      const root = path.join(tmpRoot, `codex-bridge-release-check-${role}-fixture`);
      const tree = { root, ...Object.fromEntries(['project', 'brand', 'codex', 'runs'].map((name) => [name, path.join(root, name)])) };
      trees[role] = tree;
      return tree;
    },
    isolatedEnv,
    installCandidate: ({ env, tree }) => { assert.equal(env.CODEX_HOME, tree.codex); return { ok: true }; },
    freezeInstall: ({ tree }) => ({ expectedPath: path.join(tree.project, '.claude', 'rules', 'codex-bridge', 'core.md'), sha256, snapshot: 'frozen' }),
    spawn: async (executable, args, options) => { calls.sessions.push({ executable, args, options }); return { status: 0, signal: null, stdout: 'OK', stderr: '' }; },
    awaitWitness: ({ sessionId, stateDir }) => {
      const tree = Object.values(trees).find((value) => path.join(value.brand, 'state') === stateDir);
      assert.ok(tree);
      return { sessions: { [sessionId]: { transcriptPath: path.join(tree.project, 'transcript.jsonl'), loads: [
        { path: path.join(tree.project, '.claude', 'rules', 'codex-bridge', 'core.md'), loadReason: 'session_start', sha256 },
      ] } } };
    },
    recheckFrozen: () => null, escapedWitness: () => [], removeRoleTree: ({ tree }) => { calls.removed.push(tree.root); return { ok: true }; },
    transcriptHostVersion: (_file, { sessionId }) => { assert.match(sessionId, /^uuid-/); return version; },
    revisionRun: (command, args, options) => {
      assert.equal(command, 'git'); assert.deepEqual(args, ['rev-parse', 'HEAD']);
      assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
      return { status: 0, stdout: 'fixture-revision\n' };
    },
    readJsonFile: () => ({ version: '0.0.0' }), writeAttempt: (value) => calls.attempts.push(value),
  };
  return { deps, calls, targets, trees, invoke: (argv = ['--model', model]) => main(argv, deps) };
}

test('two verified roles return 0 and persist a two-cell attempt with candidate identity', async () => {
  const f = fixture();
  const root = makeTempTree('release-check-attempt-');
  {
    f.deps.writeAttempt = writeAttempt;
    const file = path.join(root, 'attempt.json');
    assert.equal(await f.invoke(['--model', model, '--attempt-file', file]), 0);
    const attempt = await readJsonFile(file);
    assert.deepEqual(Object.keys(attempt.cells), ['cli', 'vscode']);
    assert.deepEqual(Object.values(attempt.cells).map((cell) => cell.outcome), ['verified', 'verified']);
    assert.deepEqual(attempt.candidate, { revision: 'fixture-revision', packageVersion: '0.0.0' });
    assert.equal(new Set([attempt.attemptId, ...Object.values(attempt.cells).map((cell) => cell.sessionId)]).size, 3);
    assert.equal(f.calls.sessions.length, 2);
    assert.deepEqual(f.calls.created, ['cli', 'vscode']);
    assert.equal(f.calls.removed.length, 2);
    assert.equal(f.calls.stdout.length, 3);
    assert.match(f.calls.stdout[0], /^cli: verified —/);
    assert.match(f.calls.stdout[1], /^vscode: verified —/);
    assert.equal(f.calls.stdout[2], `Attempt file: ${file}`);
  }
});

test('default attempt location is repository-relative and explicit target is forwarded', async () => {
  const f = fixture();
  assert.equal(await f.invoke(['--model', model, '--vscode-executable', 'explicit-host']), 0);
  assert.equal(f.calls.vscodeExecutable, 'explicit-host');
  assert.equal(f.calls.attempts[0].file, path.resolve(repositoryRoot, DEFAULT_ATTEMPT_PATH));
});

test('missing extension target is inconclusive while CLI is still measured', async () => {
  const f = fixture(); f.targets.vscode = { role: 'vscode', error: 'missing extension target' };
  assert.equal(await f.invoke(), 2);
  const cells = f.calls.attempts[0].attempt.cells;
  assert.equal(cells.cli.outcome, 'verified'); assert.equal(cells.vscode.outcome, 'inconclusive');
  assert.equal(cells.vscode.reason, 'missing extension target');
  assert.equal(f.calls.sessions.length, 1); assert.equal(f.calls.removed.length, 1);
});

test('a missing required preflight flag prevents that role session and tree', async () => {
  const f = fixture();
  const run = f.deps.preflightRun;
  f.deps.preflightRun = (executable, args, options) => executable === f.targets.vscode.executable && args[0] === '--help'
    ? { status: 0, stdout: '--setting-sources --tools' } : run(executable, args, options);
  assert.equal(await f.invoke(), 2);
  assert.equal(f.calls.sessions.length, 1); assert.deepEqual(f.calls.created, ['cli']);
  assert.match(f.calls.attempts[0].attempt.cells.vscode.reason, /--strict-mcp-config/);
});

test('install failure fails the cell before any session and still removes its tree', async () => {
  const f = fixture(); f.deps.installCandidate = () => ({ ok: false, reason: 'install failed' });
  assert.equal(await f.invoke(), 1); assert.equal(f.calls.sessions.length, 0); assert.equal(f.calls.removed.length, 2);
  assert.equal(f.calls.attempts[0].attempt.cells.cli.reason, 'install failed');
});

test('freeze invariant fails without a host call and removes the tree', async () => {
  const f = fixture(); f.deps.freezeInstall = () => ({ invariant: 'candidate core differs' });
  assert.equal(await f.invoke(), 1); assert.equal(f.calls.sessions.length, 0); assert.equal(f.calls.removed.length, 2);
});

test('a user-only core witness is inconclusive', async () => {
  const f = fixture(); const read = f.deps.awaitWitness;
  f.deps.awaitWitness = (input) => {
    const witness = read(input); witness.sessions[input.sessionId].loads[0].path = path.resolve('user-core.md'); return witness;
  };
  assert.equal(await f.invoke(), 2);
  assert.ok(Object.values(f.calls.attempts[0].attempt.cells).every((cell) => cell.outcome === 'inconclusive'));
});

test('a changed sentinel fails both cells after sessions', async () => {
  const f = fixture(); let count = 0;
  f.deps.realStateSentinel = () => ({ 'real-record': count++ === 0 ? 'before' : 'after' });
  assert.equal(await f.invoke(), 1); assert.equal(f.calls.sessions.length, 2);
  for (const cell of Object.values(f.calls.attempts[0].attempt.cells)) assert.equal(cell.invariant, 'real state changed: real-record');
});

test('the real witness bytes are never part of the sentinel: live sessions append to them', async () => {
  const f = fixture(); f.deps.readFile = () => { throw new Error('the real witness must not be read for the sentinel'); };
  assert.equal(await f.invoke(), 0);
});

test('sentinel change preserves an already failed cell reason', async () => {
  const f = fixture(); let count = 0;
  f.deps.realStateSentinel = () => ({ record: count++ });
  f.deps.installCandidate = ({ tree }) => tree === f.trees.cli ? { ok: false, reason: 'original failure' } : { ok: true };
  assert.equal(await f.invoke(), 1);
  assert.equal(f.calls.attempts[0].attempt.cells.cli.reason, 'original failure');
});

test('session spawn receives exactly the hardened flags, temporary roots and no host entry point', async () => {
  const f = fixture(); assert.equal(await f.invoke(), 0);
  for (const [index, role] of ['cli', 'vscode'].entries()) {
    const { executable, args, options } = f.calls.sessions[index];
    const cell = f.calls.attempts[0].attempt.cells[role];
    assert.equal(executable, f.targets[role].executable);
    assert.deepEqual(args, ['--setting-sources', 'project', '--strict-mcp-config', '--tools', '', '--model', model,
      '--session-id', cell.sessionId, '-p', 'Reply with the single word OK.']);
    assert.equal(options.timeout, 120_000); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(options.cwd, f.trees[role].project); assert.equal(options.env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(options.env.CLAUDE_CODE_EXECPATH, undefined); assert.equal(options.env.CODEX_BRIDGE_HOME, f.trees[role].brand);
    assert.equal(options.env.CODEX_HOME, f.trees[role].codex); assert.equal(options.env.CODEX_RUNS_ROOT, f.trees[role].runs);
  }
});

test('missing, unknown, duplicate and incomplete arguments return usage before any dependency call', async () => {
  for (const args of [[], ['--model'], ['--model', ''], ['--other', 'x'], ['--model', model, '--unknown'],
    ['--model', model, '--attempt-file'], ['--model', model, '--model', model], ['--model', '--tools']]) {
    const f = fixture();
    f.deps.realStateSentinel = () => { throw new Error('must not be reached'); };
    assert.equal(await f.invoke(args), 2); assert.equal(f.calls.sessions.length, 0);
    assert.equal(f.calls.preflight.length, 0); assert.equal(f.calls.attempts.length, 0); assert.match(f.calls.stderr[0], /^Usage:/);
  }
});

test('trees are removed even when the session function throws, and the second role still runs', async () => {
  const f = fixture(); f.deps.runSession = () => { throw new Error('session exploded'); };
  assert.equal(await f.invoke(), 1); assert.equal(f.calls.removed.length, 2);
  assert.match(f.calls.attempts[0].attempt.cells.cli.reason, /session exploded/);
});

test('frozen recheck and any escaped session ID fail cells', async () => {
  for (const change of [{ recheckFrozen: () => 'core bytes changed' }, { escapedWitness: () => ['unrelated-session-id'] }]) {
    const f = fixture(); Object.assign(f.deps, change);
    assert.equal(await f.invoke(), 1); assert.equal(f.calls.removed.length, 2);
    assert.match(f.calls.attempts[0].attempt.cells.cli.reason, /core bytes changed|isolation escape: unrelated-session-id/);
  }
});

test('corrupt real witness is inconclusive rather than crashing or verifying', async () => {
  const f = fixture(); f.deps.escapedWitness = () => { throw new Error('corrupt real witness'); };
  assert.equal(await f.invoke(), 2); assert.equal(f.calls.removed.length, 2);
  assert.match(f.calls.attempts[0].attempt.cells.cli.reason, /cannot prove isolation: corrupt real witness/);
});

test('removal failures and thrown removals are cell invariants', async () => {
  for (const remove of [() => ({ ok: false, reason: 'busy tree' }), () => { throw new Error('busy tree'); }]) {
    const f = fixture(); f.deps.removeRoleTree = remove;
    assert.equal(await f.invoke(), 1); assert.match(f.calls.attempts[0].attempt.cells.cli.invariant, /Role tree removal failed: busy tree/);
  }
});

test('missing and mismatched transcript host versions block verification', async () => {
  for (const observed of [null, '2.1.998']) {
    const f = fixture(); f.deps.transcriptHostVersion = () => observed; assert.equal(await f.invoke(), 2);
  }
});

test('unreadable original sentinel prevents sessions and unreadable final sentinel blocks verification', async () => {
  for (const failAt of [0, 1]) {
    const f = fixture(); let count = 0;
    f.deps.realStateSentinel = () => { if (count++ === failAt) throw new Error('access denied'); return {}; };
    assert.equal(await f.invoke(), 2); assert.equal(f.calls.sessions.length, failAt === 0 ? 0 : 2);
    assert.match(f.calls.attempts[0].attempt.cells.cli.reason, /cannot prove isolation/);
  }
});

test('host exit, signal, process error and rejected spawn report failure with bounded stderr', async () => {
  const f = fixture();
  for (const result of [{ status: 1, stderr: 'failure tail' }, { status: 0, signal: 'SIGTERM', stderr: 'failure tail' },
    { status: 0, error: new Error('spawn failed'), stderr: 'x'.repeat(5000) + 'failure tail' }]) {
    const value = await runSession({ target: f.targets.cli, tree: { project: 'fake' }, env: {}, model, sessionId: 'session', spawn: async () => result });
    assert.equal(value.ok, false); assert.match(value.reason, /failure tail$/); assert.ok(value.reason.length < 4100);
  }
  const result = await runSession({ target: f.targets.cli, tree: { project: 'fake' }, env: {}, model, sessionId: 'session',
    spawn: async () => { throw new Error('rejected fake'); } });
  assert.equal(result.ok, false); assert.match(result.reason, /rejected fake/);
});

test('session failure becomes a failed cell and each console summary remains a single line', async () => {
  const f = fixture(); f.deps.spawn = async () => ({ status: 1, stderr: 'line one\nline two' });
  assert.equal(await f.invoke(), 1); assert.equal(f.calls.removed.length, 2);
  assert.match(f.calls.attempts[0].attempt.cells.cli.reason, /line two/);
  assert.ok(f.calls.stdout.every((line) => !/[\r\n]/.test(line)));
});

test('witness polling waits for this session with at least one load and bounds the deadline', async () => {
  let clock = 0; let reads = 0; const sleeps = [];
  const witness = { sessions: { wanted: { loads: [{}] } } };
  const result = await awaitWitness({ stateDir: 'fake-state', sessionId: 'wanted', deadlineMs: 100, pollMs: 30,
    now: () => clock, sleep: async (ms) => { clock += ms; sleeps.push(ms); },
    read: ({ stateDir }) => { assert.equal(stateDir, 'fake-state'); return ++reads < 3 ? { sessions: { other: { loads: [{}] }, wanted: { loads: [] } } } : witness; },
  });
  assert.equal(result, witness); assert.equal(reads, 3); assert.deepEqual(sleeps, [30, 30]);
  clock = 0; sleeps.length = 0;
  const absent = { sessions: {} };
  assert.equal(await awaitWitness({ stateDir: 'fake-state', sessionId: 'wanted', deadlineMs: 100, pollMs: 30,
    now: () => clock, sleep: async (ms) => { clock += ms; sleeps.push(ms); }, read: () => absent }), absent);
  assert.deepEqual(sleeps, [30, 30, 30, 10]); assert.equal(clock, 100);
});

test('witness polling with an expected path waits past an earlier user-core load', async () => {
  let clock = 0; let reads = 0;
  const userOnly = { sessions: { wanted: { loads: [{ path: 'C:/home/.claude/rules/codex-bridge/core.md' }] } } };
  const both = { sessions: { wanted: { loads: [...userOnly.sessions.wanted.loads, { path: 'C:\\tmp\\project\\.claude\\rules\\codex-bridge\\core.md' }] } } };
  const result = await awaitWitness({ stateDir: 'fake', sessionId: 'wanted', expectedPath: 'C:/tmp/project/.claude/rules/codex-bridge/core.md',
    deadlineMs: 100, pollMs: 30, now: () => clock, sleep: async (ms) => { clock += ms; },
    read: () => (++reads < 3 ? userOnly : both) });
  assert.equal(result, both); assert.equal(reads, 3);
});

test('witness polling returns corruption at deadline and never accepts inherited sessions', async () => {
  const corrupt = { sessions: {}, corrupt: true };
  assert.equal(await awaitWitness({ stateDir: 'fake', sessionId: 'wanted', deadlineMs: 0, read: () => corrupt }), corrupt);
  const inherited = { sessions: Object.create({ wanted: { loads: [{}] } }) };
  assert.equal(await awaitWitness({ stateDir: 'fake', sessionId: 'wanted', deadlineMs: 0, read: () => inherited }), inherited);
});
