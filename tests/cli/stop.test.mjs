/** Verifies operator shutdown preserves honest FAIL artifacts without invoking Codex. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { HEARTBEAT_FILE } from '../../src/home/lib/heartbeat.mjs';
import { resolveProjectRunsDir } from '../../src/home/lib/runner/project-dir.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const realSpawnSync = childProcess.spawnSync;
if (process.platform === 'win32') {
  // The managed test host denies the real taskkill utility; preserve the production call shape
  // while killing the fixture process through the same recorded pid in this test process.
  childProcess.spawnSync = (command, args, options) => {
    if (command !== 'taskkill') return realSpawnSync(command, args, options);
    try {
      process.kill(Number(args[1]), 'SIGKILL');
    } catch {}
    return { status: 0, error: null };
  };
  syncBuiltinESMExports();
}
const { stop } = await import('../../cli/stop.mjs');
const { main } = await import('../../bin/codex-bridge.mjs');
after(() => {
  if (process.platform === 'win32') {
    childProcess.spawnSync = realSpawnSync;
    syncBuiltinESMExports();
  }
});

function fixture(t) {
  const root = makeTempTree('stop-');
  const project = path.join(root, 'project');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(project);
  const projectRuns = resolveProjectRunsDir(runsRoot, project).dir;
  t.after(() => removeTempTree(root));
  return { project, projectRuns, runsRoot };
}

function json(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeRun(dir, status, meta) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
  if (meta) fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}

const liveStatus = (repo, pid) => ({
  state: 'running',
  pid,
  agent: 'codex-build',
  slug: 'stop-test',
  order_id: 'order-stop',
  repo,
  started_at: new Date().toISOString(),
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
}

function liveProcess() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

test('stop kills a live process and closes the run with FAIL artifacts', async (t) => {
  const { project, projectRuns, runsRoot } = fixture(t);
  const child = liveProcess();
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  });
  assert.equal(await waitFor(() => Number.isInteger(child.pid) && alive(child.pid)), true);
  const runDir = path.join(projectRuns, '2026-08-04_090000_stop-test');
  writeRun(runDir, liveStatus(project, child.pid));

  const result = await stop({ run: path.basename(runDir), cwd: project, runsRootPath: runsRoot });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /recorded FAIL verdict/);
  assert.equal(await waitFor(() => !alive(child.pid)), true);
  assert.equal(json(path.join(runDir, 'meta.json')).status, 'FAIL');
  const status = json(path.join(runDir, 'status.json'));
  assert.equal(status.state, 'abandoned');
  assert.equal(status.status, 'FAIL');
  assert.ok(status.abandoned_at);
});

test('stop does not probe while waiting for a confirmed process to die', async (t) => {
  const { project, projectRuns, runsRoot } = fixture(t);
  const child = liveProcess();
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  });
  assert.equal(await waitFor(() => Number.isInteger(child.pid) && alive(child.pid)), true);
  const runDir = path.join(projectRuns, '2026-08-04_090000_stop-no-probe');
  writeRun(runDir, liveStatus(project, child.pid));
  fs.writeFileSync(path.join(runDir, HEARTBEAT_FILE), 'progress\n');
  let probes = 0;
  const commandRunner = () => {
    probes += 1;
    throw new Error('process probe must not run while waiting for a confirmed stop');
  };

  const result = await stop({
    run: path.basename(runDir),
    cwd: project,
    runsRootPath: runsRoot,
    commandRunner,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(probes, 0);
  assert.equal(await waitFor(() => !alive(child.pid)), true);
});

test('stop leaves a finished run byte-for-byte unchanged', async (t) => {
  const { project, projectRuns, runsRoot } = fixture(t);
  const runDir = path.join(projectRuns, '2026-08-04_090000_finished');
  writeRun(runDir, { state: 'finished', status: 'OK', pid: process.pid }, { status: 'OK', answer: 'done' });
  const beforeStatus = fs.readFileSync(path.join(runDir, 'status.json'));
  const beforeMeta = fs.readFileSync(path.join(runDir, 'meta.json'));

  const result = await stop({ run: runDir, cwd: project, runsRootPath: runsRoot });

  assert.equal(result.exitCode, 0);
  assert.equal(result.output, `Run ${runDir} already has a verdict (OK); no changes made.`);
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'status.json')), beforeStatus);
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'meta.json')), beforeMeta);
});

for (const state of ['running', undefined]) {
  test(`stop names a finished parent's automatic child with state ${state || 'unknown'} without signalling`, async (t) => {
    const { project, projectRuns, runsRoot } = fixture(t);
    const worker = liveProcess();
    t.after(() => {
      try {
        worker.kill('SIGKILL');
      } catch {}
    });
    assert.equal(await waitFor(() => Number.isInteger(worker.pid) && alive(worker.pid)), true);
    const runDir = path.join(projectRuns, '2026-08-04_090000_parent');
    const childName = '2026-08-04_090100_automatic';
    const childDir = path.join(projectRuns, childName);
    const identity = liveStatus(project, worker.pid);
    writeRun(runDir, {
      ...identity, state: 'finished', recovery: { automatic: true, child: childName },
    }, { status: 'FAIL' });
    writeRun(childDir, {
      ...identity, state, resumed_from: path.basename(runDir),
      recovery: { automatic: true, attempt: 2, parent: path.basename(runDir) },
    });
    fs.writeFileSync(path.join(runDir, 'reply.txt'), 'FAIL — parent stopped\n');
    fs.writeFileSync(path.join(childDir, 'sentinel.bin'), Buffer.from([0, 255, 13, 10]));
    const snapshot = () => [runDir, childDir].map((dir) => fs.readdirSync(dir).sort()
      .map((name) => [name, fs.readFileSync(path.join(dir, name))]));
    const before = snapshot();

    const result = await stop({
      run: runDir, cwd: project, runsRootPath: runsRoot,
      commandRunner: () => assert.fail('a recorded verdict must not probe a process'),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, `Run ${runDir} already has a verdict (FAIL); no changes made.` +
      ` It was continued automatically in ${childDir} (state: ${state || 'unknown'}); to stop that run, use codex-bridge stop ${childName}.`);
    assert.equal(alive(worker.pid), true, 'the shared parent/child worker must not be signalled');
    assert.deepEqual(snapshot(), before, 'every parent and child file must remain byte-identical');
  });
}

test('stop preserves the exact recorded-verdict output for an invalid automatic pointer', async (t) => {
  const { project, projectRuns, runsRoot } = fixture(t);
  const runDir = path.join(projectRuns, '2026-08-04_090000_invalid');
  writeRun(runDir, {
    ...liveStatus(project, process.pid), state: 'finished',
    recovery: { automatic: true, child: '../outside' },
  }, { status: 'FAIL' });
  const before = ['status.json', 'meta.json'].map((name) => fs.readFileSync(path.join(runDir, name)));

  const result = await stop({ run: runDir, cwd: project, runsRootPath: runsRoot });

  assert.equal(result.exitCode, 0);
  assert.equal(result.output, `Run ${runDir} already has a verdict (FAIL); no changes made.`);
  assert.deepEqual(['status.json', 'meta.json'].map((name) => fs.readFileSync(path.join(runDir, name))), before);
});

test('stop reports a missing folder as an actionable error', async (t) => {
  const { project, runsRoot } = fixture(t);
  const missing = path.join(project, 'no-such-run');

  const result = await stop({ run: missing, cwd: project, runsRootPath: runsRoot });

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Run folder not found/);
  assert.doesNotMatch(result.output, /at .*stop/);
});

test('the dispatcher routes stop errors without a stack trace', async (t) => {
  const { project } = fixture(t);
  const output = [];
  const errors = [];
  const missing = path.join(project, 'no-such-run');

  const code = await main(['stop', missing], {
    log: (line) => output.push(line),
    error: (line) => errors.push(line),
  });

  assert.equal(code, 1);
  assert.equal(errors.length, 0);
  assert.match(output[0], /Run folder not found/);
  assert.doesNotMatch(output[0], /at .*stop/);
});
