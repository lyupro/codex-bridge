/** Contract tests for kernel-released lifecycle locks and the declared file fallback. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { acquireLifecycleLock } from '../../cli/lifecycle-lock.mjs';
import { makeTempTree } from '../temp-tree.mjs';

const moduleUrl = pathToFileURL(fileURLToPath(new URL('../../cli/lifecycle-lock.mjs', import.meta.url))).href;
const childSource = [
  'import { acquireLifecycleLock } from ' + JSON.stringify(moduleUrl) + ';',
  'const [homeRoot, mode, command, hostRoot] = process.argv.slice(2);',
  'try {',
  '  const lock = await acquireLifecycleLock(homeRoot, { command, hostRoot, waitMs: 200, retryMs: 20, answerTimeoutMs: 500 });',
  '  if (mode === "hold") { process.stdout.write("ready\\n"); setInterval(() => {}, 1000); }',
  '  else { await lock.release(); process.stdout.write("acquired\\n"); }',
  '} catch (error) { process.stdout.write("error: " + error.message + "\\n"); process.exitCode = 2; }',
].join('\n');

function startChild(tree, homeRoot, mode, command) {
  const script = path.join(tree, 'lifecycle-child.mjs');
  fs.writeFileSync(script, childSource);
  const child = spawn(process.execPath, [
    script, homeRoot, mode, command, path.join(tree, 'host-' + command),
  ], { windowsHide: true });
  const firstLine = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('child did not answer')), 5_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline !== -1) {
        clearTimeout(timer);
        resolve(output.slice(0, newline));
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (output.includes('\n')) return;
      clearTimeout(timer);
      reject(new Error('child exited before answering: ' + code + ' ' + signal + ' ' + output));
    });
  });
  return { child, firstLine };
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

test('two processes serialize a home and a killed holder releases its socket', {
  skip: ['win32', 'linux'].includes(process.platform) ? false : 'kernel socket locks are only used on Windows and Linux',
}, async () => {
  const tree = makeTempTree('lifecycle-lock-process-');
  const homeRoot = tree;
  const { child, firstLine } = startChild(tree, homeRoot, 'hold', 'child-command');
  try {
    assert.equal(await firstLine, 'ready');
    await assert.rejects(
      acquireLifecycleLock(homeRoot, {
        command: 'parent-command',
        hostRoot: path.join(tree, 'parent-host'),
        waitMs: 300,
        retryMs: 20,
        answerTimeoutMs: 500,
      }),
      (error) => error.message.includes('held by child-command')
        && error.message.includes('pid ' + child.pid)
        && error.message.includes('nothing was changed'),
    );
    await killChild(child);
    const lock = await acquireLifecycleLock(homeRoot, {
      command: 'parent-command',
      hostRoot: path.join(tree, 'parent-host'),
      waitMs: 300,
      retryMs: 20,
    });
    await lock.release();
  } finally {
    await killChild(child);
  }
});

test('a junction alias resolves to the same Windows home lock', {
  skip: process.platform === 'win32' ? false : 'junction alias identity is Windows-specific',
}, async () => {
  const tree = makeTempTree('lifecycle-lock-alias-');
  const homeRoot = tree;
  const alias = path.join(tree, 'home-alias');
  fs.symlinkSync(homeRoot, alias, 'junction');
  const held = await acquireLifecycleLock(homeRoot, {
    command: 'parent-command',
    hostRoot: path.join(tree, 'parent-host'),
  });
  const { child, firstLine } = startChild(tree, alias, 'attempt', 'alias-command');
  const childExit = once(child, 'exit');
  try {
    const answer = await firstLine;
    assert.match(answer, /^error: lifecycle lock busy for /);
    assert.ok(answer.includes('held by parent-command'));
    assert.ok(answer.includes('nothing was changed'));
    await childExit;
  } finally {
    await killChild(child);
    await held.release();
  }
});

test('release is awaited, idempotent, and permits reacquisition', async () => {
  const tree = makeTempTree('lifecycle-lock-release-');
  const options = { command: 'release-test', hostRoot: tree, waitMs: 200, retryMs: 20 };
  const first = await acquireLifecycleLock(tree, options);
  await first.release();
  await first.release();
  const second = await acquireLifecycleLock(tree, options);
  assert.equal(typeof second.token, 'string');
  await second.release();
});

test('a socket self-check failure closes the real listener', async () => {
  const tree = makeTempTree('lifecycle-lock-self-check-');
  let calls = 0;
  const createServer = (handler) => {
    calls += 1;
    if (calls === 1) return net.createServer(handler);
    const probe = new EventEmitter();
    probe.listening = false;
    probe.listen = () => {
      setImmediate(() => {
        probe.listening = true;
        probe.emit('listening');
      });
      return probe;
    };
    probe.close = (callback) => {
      probe.listening = false;
      if (callback) callback();
      return probe;
    };
    probe.unref = () => probe;
    return probe;
  };
  await assert.rejects(
    acquireLifecycleLock(tree, {
      command: 'self-check-test',
      hostRoot: tree,
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      createServer,
    }),
    /self-check failed: a second listener succeeded/,
  );
  const lock = await acquireLifecycleLock(tree, {
    command: 'after-self-check',
    hostRoot: tree,
  });
  await lock.release();
});

test('the file fallback never removes a pre-existing lock and removes its own', async () => {
  const tree = makeTempTree('lifecycle-lock-file-');
  const lockPath = path.join(tree, '.installed.json.lock');
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 1,
    command: 'dead-command',
    hostRoot: path.join(tree, 'dead-host'),
    acquiredAt: '2026-01-01T00:00:00.000Z',
    token: 'dead-token',
  }) + '\n');
  await assert.rejects(
    acquireLifecycleLock(tree, {
      command: 'file-test',
      hostRoot: tree,
      platform: 'darwin',
      waitMs: 200,
      retryMs: 20,
    }),
    (error) => error.message.includes('unlock --lifecycle')
      && error.message.includes('held by dead-command'),
  );
  assert.equal(fs.existsSync(lockPath), true);

  fs.unlinkSync(lockPath);
  const lock = await acquireLifecycleLock(tree, {
    command: 'file-test',
    hostRoot: tree,
    platform: 'darwin',
    waitMs: 200,
    retryMs: 20,
  });
  assert.equal(lock.strategy, 'file');
  assert.equal(fs.existsSync(lockPath), true);
  await lock.release();
  assert.equal(fs.existsSync(lockPath), false);
});
