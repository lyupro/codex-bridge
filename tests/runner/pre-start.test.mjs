#!/usr/bin/env node
/**
 * Guards the four launcher refusals that spend no Codex quota.
 *
 * Plan_23 showed that each refusal still needs a durable pre-start verdict, otherwise a
 * harmless folder is counted as paid work by the next order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { resolveProjectRunsDir } from '../../src/home/lib/runner/project-dir.mjs';

const RUN_CODEX = fileURLToPath(new URL('../../src/home/lib/run-codex.mjs', import.meta.url));
const LAUNCHER = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;

function fixture(t, suffix) {
  const root = makeTempTree(`pre-start-${suffix}-`);
  t.after(() => removeTempTree(root));
  return root;
}

function runner(args, input, env, cwd) {
  return spawnSync(process.execPath, [RUN_CODEX, ...args], {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
  });
}

function mockedLauncher(source, args, input, env, cwd) {
  const script = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
${source}
syncBuiltinESMExports();
process.argv = [process.execPath, ${JSON.stringify(LAUNCHER)}, ...${JSON.stringify(args)}];
const { launcher } = await import(${JSON.stringify(LAUNCHER)});
const exitCode = await launcher();
if (exitCode !== undefined) process.exitCode = exitCode;
`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
  });
}

function runStatus(output) {
  const line = output.stdout.split(/\r?\n/).find((part) => part.startsWith('RUN='));
  assert.ok(line, `launcher did not print a run path:\n${output.stdout}\n${output.stderr}`);
  const runDir = line.slice(4).split(' order-id=', 1)[0];
  return JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
}

function baseArgs(agent, repo, orderId) {
  return [
    '--agent', agent,
    '--repo', repo,
    '--slug', 'pre-start-test',
    '--order-id', orderId,
    ...(agent === 'codex-build' ? ['--scope', 'src/**'] : []),
  ];
}

test('the busy refusal records aborted_pre_start', (t) => {
  const root = fixture(t, 'busy');
  const repo = path.join(root, 'repo');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'existing.mjs'), 'export default 1;\n');
  const project = resolveProjectRunsDir(runsRoot, repo).dir;
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => holder.kill());
  fs.mkdirSync(path.join(project, 'other-live-run'));
  fs.writeFileSync(
    path.join(project, 'other-live-run', 'status.json'),
    JSON.stringify({
      state: 'running',
      pid: holder.pid,
      agent: 'codex-build',
      repo,
      slug: 'other-task',
      task_hash: 'other-hash',
      order_id: 'other-order',
      started_at: new Date().toISOString(),
    }),
  );

  const output = runner(baseArgs('codex-build', repo, 'busy-order'), 'busy refusal', { CODEX_RUNS_ROOT: runsRoot }, repo);

  assert.equal(output.status, 1, output.stderr);
  assert.equal(runStatus(output).state, 'aborted_pre_start');
});

test('the unsafe-for-cmd refusal records aborted_pre_start', (t) => {
  // cmd.exe is the only shell this refusal exists for; a bare return would report the case as
  // passed on every other platform, which is the kind of green a suite must never print.
  if (process.platform !== 'win32') return t.skip('cmd.exe quoting is a Windows-only refusal');
  const root = fixture(t, 'unsafe');
  const repo = path.join(root, 'repo%unsafe');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(repo);
  const source = `
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) =>
  command === 'git' ? realSpawnSync(command, args, options) : { status: 0, error: null, stderr: '', stdout: '' };
`;

  const output = mockedLauncher(source, baseArgs('codex-review', repo, 'unsafe-order'), 'unsafe refusal', {
    CODEX_RUNS_ROOT: runsRoot,
  }, repo);

  assert.equal(output.status, 1, output.stderr);
  assert.equal(runStatus(output).state, 'aborted_pre_start');
});

test('a worker spawn error records aborted_pre_start', (t) => {
  const root = fixture(t, 'spawn');
  const repo = path.join(root, 'repo');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(repo);
  const source = `
import { EventEmitter } from 'node:events';
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) =>
  command === 'git' ? realSpawnSync(command, args, options) : { status: 0, error: null, stderr: '', stdout: '' };
childProcess.spawn = () => {
  const worker = new EventEmitter();
  worker.pid = 999999;
  worker.unref = () => {};
  queueMicrotask(() => worker.emit('error', new Error('fixture worker spawn failure')));
  return worker;
};
const realExit = process.exit;
process.exit = (code = 0) => { process.exitCode = code; };
`;
  const output = mockedLauncher(source, baseArgs('codex-review', repo, 'spawn-order'), 'worker refusal', {
    CODEX_RUNS_ROOT: runsRoot,
  }, repo);

  assert.equal(output.status, 1, output.stderr);
  assert.equal(runStatus(output).state, 'aborted_pre_start');
});

/** An earlier run of the same task, as the next launcher call finds it on disk. */
function earlierRun(project, name, status, meta) {
  fs.mkdirSync(path.join(project, name), { recursive: true });
  fs.writeFileSync(path.join(project, name, 'status.json'), JSON.stringify(status));
  if (meta) fs.writeFileSync(path.join(project, name, 'meta.json'), JSON.stringify(meta));
}

const gateStatus = (repo, orderId, state) => ({
  state,
  pid: 1,
  agent: 'codex-review',
  slug: 'pre-start-test',
  order_id: orderId,
  repo,
  started_at: '2026-08-07T12:00:00.000Z',
});

// The acceptance case of the vaultforge incident, end to end: the launcher itself must start,
// not merely the predicate underneath it. A folder left by a guard refusal used to send the
// second attempt to the --continue gate, and the orchestrator paid for a whole extra round trip.
test('a pre-start folder does not make the same order ask for a continuation', (t) => {
  const root = fixture(t, 'gate-open');
  const repo = path.join(root, 'repo');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(repo);
  const project = resolveProjectRunsDir(runsRoot, repo).dir;
  earlierRun(project, '2026-08-07_120000_pre-start-test', gateStatus(repo, 'gate-order', 'aborted_pre_start'), {
    exit: null,
    status: 'FAIL',
    session_id: null,
    events_bytes: 0,
    stderr_bytes: 0,
    tokens_reported: false,
    reason: 'run 2026-08-07_115000_other is already active for this repository',
  });
  const source = `
import { EventEmitter } from 'node:events';
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) =>
  command === 'git' ? realSpawnSync(command, args, options) : { status: 0, error: null, stderr: '', stdout: '' };
childProcess.spawn = () => {
  const worker = new EventEmitter();
  worker.pid = 999999;
  worker.unref = () => {};
  queueMicrotask(() => worker.emit('spawn'));
  return worker;
};
process.exit = (code = 0) => { process.exitCode = code; };
`;

  const output = mockedLauncher(source, baseArgs('codex-review', repo, 'gate-order'), 'gate task', {
    CODEX_RUNS_ROOT: runsRoot,
  }, repo);

  assert.doesNotMatch(output.stderr, /--continue is required/);
  assert.match(output.stdout, /^RUN=/m, `${output.stdout}\n${output.stderr}`);
});

// The other half of the same contract: a folder that did have a Codex session still costs a
// grant. Without this the fix would read as "repeats are free", which is the 46k incident of
// 2026-08-02 all over again.
test('a folder with a Codex session still sends the same order to the continuation gate', (t) => {
  const root = fixture(t, 'gate-closed');
  const repo = path.join(root, 'repo');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(repo);
  const project = resolveProjectRunsDir(runsRoot, repo).dir;
  earlierRun(project, '2026-08-07_120000_pre-start-test', gateStatus(repo, 'gate-order', 'finished'), {
    exit: 0,
    status: 'OK',
    session_id: 'thread-abc',
    events_bytes: 8192,
    stderr_bytes: 512,
    tokens_reported: true,
  });

  const output = runner(baseArgs('codex-review', repo, 'gate-order'), 'gate task', { CODEX_RUNS_ROOT: runsRoot }, repo);

  assert.equal(output.status, 2, output.stderr);
  assert.match(output.stderr, /--continue is required/);
  assert.doesNotMatch(output.stdout, /^RUN=/m);
});

test('an unavailable Codex CLI records aborted_pre_start', (t) => {
  const root = fixture(t, 'codex');
  const runDir = path.join(root, 'run');
  fs.mkdirSync(runDir);
  const source = `
import childProcess from 'node:child_process';
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) =>
  command === 'git' ? realSpawnSync(command, args, options) : { status: 1, error: new Error('Codex missing'), stderr: '', stdout: '' };
import { syncBuiltinESMExports } from 'node:module';
syncBuiltinESMExports();
process.exit = (code = 0) => { process.exitCode = code; };
const { requireCodex } = await import(${JSON.stringify(new URL('../../src/home/lib/runner/codex-cmd.mjs', import.meta.url).href)});
requireCodex(${JSON.stringify(runDir)}, 'codex-review');
`;
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: process.env,
    encoding: 'utf8',
  });

  assert.equal(output.status, 1, output.stderr);
  const statusPath = path.join(runDir, 'status.json');
  assert.ok(fs.existsSync(statusPath), `${output.stdout}\n${output.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(statusPath, 'utf8')).state, 'aborted_pre_start');
});
