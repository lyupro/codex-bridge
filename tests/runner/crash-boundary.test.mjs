import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { collect, exitCodeFor } from '../../src/home/lib/write-meta.mjs';
import {
  adoptRun, emitReply, getRun, setRun, setWorkerDir,
} from '../../src/home/lib/runner/run-context.mjs';
import { makeTempTree } from '../temp-tree.mjs';
import { buildResult, COMPLETED_COMMAND, makeRun } from '../meta/test-fixtures.mjs';

const runnerUrl = new URL('../../src/home/lib/run-codex.mjs', import.meta.url).href;
const contextUrl = new URL('../../src/home/lib/runner/run-context.mjs', import.meta.url).href;
const agent = 'codex-build';
const crashMessage = `continuation\n reservation\t failed ${'x'.repeat(180)}`;
const crashLine = `Runner crashed after the verdict was recorded: ${
  crashMessage.replace(/\s+/g, ' ').slice(0, 150)
}`;
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const readJson = (dir, file) => JSON.parse(read(dir, file));

function crash({ dir, currentAgent = agent, parent, launcher = false }) {
  const code = `
    import { installRunnerCrashBoundary } from ${JSON.stringify(runnerUrl)};
    import { adoptRun, setRun, setWorkerDir } from ${JSON.stringify(contextUrl)};
    installRunnerCrashBoundary();
    setWorkerDir(${JSON.stringify(launcher ? null : parent ?? dir)});
    setRun(${JSON.stringify(parent ?? dir)}, ${JSON.stringify(currentAgent)});
    ${parent ? `adoptRun(${JSON.stringify(dir)}, ${JSON.stringify(currentAgent)});` : ''}
    throw new Error(${JSON.stringify(crashMessage)});
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, child.stderr);
  return child;
}

function recordedRun(result) {
  const dir = makeRun({
    result,
    stderr: 'existing diagnostic\n',
    events: [{ type: 'thread.started', thread_id: 'crash-boundary-fixture' }, COMPLETED_COMMAND],
    status: { state: 'running', agent, stop: { trigger: 'exit' } },
  });
  return { dir, ...collect(dir, agent, 0) };
}

function assertRecordedFiles(dir, before) {
  for (const file of ['meta.json', 'status.json']) {
    assert.deepEqual(fs.readFileSync(path.join(dir, file)), before[file], `${file} changed`);
  }
  assert.equal(readJson(dir, 'status.json').state, 'finished');
}

// Plan_80 E17, A14/A15: later runner failures must not erase the stop or continuation rows.
for (const [label, result, expectedStatus] of [
  ['FAIL without a result', undefined, 'FAIL'],
  ['OK with a result', buildResult([]), 'OK'],
]) {
  test(`crash preserves a collected ${label} verdict and reply`, () => {
    const { dir, meta, reply } = recordedRun(result);
    assert.equal(meta.status, expectedStatus);
    if (expectedStatus === 'FAIL') assert.match(reply, /Continuation:/);
    fs.writeFileSync(path.join(dir, 'reply.txt'), `${reply}\n`);
    const before = Object.fromEntries(['meta.json', 'status.json'].map((file) => [
      file, fs.readFileSync(path.join(dir, file)),
    ]));
    const stderr = read(dir, 'stderr.log');

    const child = crash({ dir });

    assert.equal(child.status, exitCodeFor(meta.status), child.stderr);
    assertRecordedFiles(dir, before);
    assert.equal(read(dir, 'reply.txt'), `${reply}\n${crashLine}\nLog: codex-bridge read ${dir}\n`);
    assert.ok(read(dir, 'stderr.log').startsWith(`${stderr}\nrun-codex crash: Error: `));
    assert.ok(read(dir, 'stderr.log').includes(crashMessage));
  });
}

for (const [label, contents] of [
  ['missing metadata', undefined],
  ['unreadable JSON', '{'],
  ['metadata without a string status', JSON.stringify({ status: 0 })],
  ['null metadata', 'null'],
]) {
  test(`crash without a verdict writes FAIL: ${label}`, () => {
    const dir = makeTempTree('crash-no-verdict-');
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ state: 'running', agent }));
    if (contents !== undefined) fs.writeFileSync(path.join(dir, 'meta.json'), contents);

    const child = crash({ dir });

    assert.equal(child.status, exitCodeFor('FAIL'), child.stderr);
    const meta = readJson(dir, 'meta.json');
    assert.equal(meta.status, 'FAIL');
    assert.match(meta.reason, /^Codex runner crashed:/);
    assert.equal(readJson(dir, 'status.json').state, 'failed');
    assert.match(read(dir, 'reply.txt'), /^FAIL — Codex runner crashed:/);
    assert.match(read(dir, 'stderr.log'), /run-codex crash: Error:/);
  });
}

for (const reason of ['recorded reason', null]) {
  test(`render failure preserves the verdict with ${reason === null ? 'a fallback' : 'its'} reason`, () => {
    const { dir, meta } = recordedRun();
    meta.status = 'LIMIT';
    meta.reason = reason;
    fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    const before = Object.fromEntries(['meta.json', 'status.json'].map((file) => [
      file, fs.readFileSync(path.join(dir, file)),
    ]));

    // Unknown agent makes renderReply throw without mocking or changing production modules.
    const child = crash({ dir, currentAgent: 'unknown-agent' });

    assert.equal(child.status, exitCodeFor(meta.status), child.stderr);
    assertRecordedFiles(dir, before);
    assert.equal(read(dir, 'reply.txt'), [
      `LIMIT — ${reason ?? 'verdict recorded in meta.json'}`,
      crashLine,
      `Log: codex-bridge read ${dir}\n`,
    ].join('\n'));
  });
}

test('a launcher crash with a recorded verdict answers on stdout', () => {
  const { dir, meta, reply } = recordedRun(buildResult([]));
  const before = Object.fromEntries(['meta.json', 'status.json'].map((file) => [
    file, fs.readFileSync(path.join(dir, file)),
  ]));

  const child = crash({ dir, launcher: true });

  assert.equal(child.status, exitCodeFor(meta.status), child.stderr);
  assertRecordedFiles(dir, before);
  assert.equal(child.stdout, `${reply}\n${crashLine}\nLog: codex-bridge read ${dir}\n`);
  assert.equal(fs.existsSync(path.join(dir, 'reply.txt')), false);
});

// Plan_80 E17, A12: adopting a child must move both the crash target and reply destination.
test('adoptRun sends crash artifacts and the reply to the child only', () => {
  const { dir: parent } = recordedRun();
  const childDir = makeTempTree('crash-child-');
  fs.writeFileSync(path.join(childDir, 'status.json'), JSON.stringify({ state: 'running', agent }));
  const before = Object.fromEntries(fs.readdirSync(parent).map((file) => [
    file, fs.readFileSync(path.join(parent, file)),
  ]));

  const child = crash({ dir: childDir, parent });

  assert.equal(child.status, exitCodeFor('FAIL'), child.stderr);
  assert.equal(readJson(childDir, 'meta.json').status, 'FAIL');
  assert.equal(readJson(childDir, 'status.json').state, 'failed');
  assert.match(read(childDir, 'reply.txt'), /^FAIL — Codex runner crashed:/);
  assert.match(read(childDir, 'stderr.log'), /run-codex crash: Error:/);
  assert.deepEqual(fs.readdirSync(parent), Object.keys(before));
  for (const [file, bytes] of Object.entries(before)) {
    assert.deepEqual(fs.readFileSync(path.join(parent, file)), bytes, `${file} changed in parent`);
  }
  assert.equal(fs.existsSync(path.join(parent, 'reply.txt')), false);
});

test('adoptRun moves emitReply and the current agent together', () => {
  const parent = makeTempTree('reply-parent-');
  const child = makeTempTree('reply-child-');
  try {
    setWorkerDir(parent);
    setRun(parent, agent);
    adoptRun(child, 'codex-scout');
    assert.deepEqual(getRun(), { dir: child, agent: 'codex-scout' });
    emitReply('x');
    assert.equal(read(child, 'reply.txt'), 'x\n');
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally {
    setWorkerDir(null);
    setRun(null, null);
  }
});

test('adoptRun refuses the launcher without changing its context', () => {
  setWorkerDir(null);
  setRun('launcher-run', agent);
  try {
    assert.throws(() => adoptRun('child-run', 'codex-scout'), {
      message: 'adoptRun is for the worker half only',
    });
    assert.deepEqual(getRun(), { dir: 'launcher-run', agent });
  } finally {
    setRun(null, null);
  }
});
