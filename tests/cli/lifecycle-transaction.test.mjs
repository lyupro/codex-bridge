/** Lifecycle transactions: one lock per home, taken before the first change, handed to nested install as a ticket. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { install } from '../../cli/install.mjs';
import { buildInstallPlan } from '../../cli/manifest.mjs';
import { withLifecycle } from '../../cli/lifecycle-transaction.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { update } from '../../cli/update.mjs';
import { fixture } from './host-fixture.mjs';

const lockModuleUrl = pathToFileURL(fileURLToPath(new URL('../../cli/lifecycle-lock.mjs', import.meta.url))).href;
const holderSource = [
  'import { acquireLifecycleLock } from ' + JSON.stringify(lockModuleUrl) + ';',
  'const [homeRoot, hostRoot] = process.argv.slice(2);',
  'try {',
  '  const lock = await acquireLifecycleLock(homeRoot, { command: "test-holder", hostRoot, waitMs: 1000, retryMs: 20, answerTimeoutMs: 500 });',
  '  process.stdout.write("ready\\n");',
  '  setInterval(() => {}, 1000);',
  '} catch (error) {',
  '  process.stdout.write("error: " + error.message + "\\n");',
  '  process.exitCode = 1;',
  '}',
].join('\n');
const childSkip = ['win32', 'linux'].includes(process.platform)
  ? false
  : 'kernel socket locks are only used on Windows and Linux';

async function startHolder(tree, host) {
  const script = path.join(tree, 'lifecycle-holder.mjs');
  await fsp.writeFile(script, holderSource);
  const child = spawn(process.execPath, [script, host.brandRoot, host.root], { windowsHide: true });
  const firstLine = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('child did not answer')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      resolve(output.slice(0, newline));
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

async function readOptional(file) {
  try {
    return await fsp.readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

test('install refuses a busy home before changing settings or writing its record', { skip: childSkip }, async (t) => {
  const { root, host } = await fixture(t);
  const settingsBefore = await readOptional(host.settingsPath);
  const { child, firstLine } = await startHolder(root, host);
  try {
    assert.equal(await firstLine, 'ready');
    await assert.rejects(install({ host, lifecycleWaitMs: 200 }), /lifecycle lock busy/);
    assert.deepEqual(await readOptional(host.settingsPath), settingsBefore);
    assert.equal(await readOptional(path.join(host.brandRoot, '.installed.json')), null);
  } finally {
    await killChild(child);
  }
});

test('uninstall refuses a busy home before removing permission rules', { skip: childSkip }, async (t) => {
  const { root, host } = await fixture(t);
  await install({ host });
  const settingsBefore = await fsp.readFile(host.settingsPath);
  const { child, firstLine } = await startHolder(root, host);
  try {
    assert.equal(await firstLine, 'ready');
    await assert.rejects(uninstall({ host, lifecycleWaitMs: 200 }), /lifecycle lock busy/);
    assert.deepEqual(await fsp.readFile(host.settingsPath), settingsBefore);
  } finally {
    await killChild(child);
  }
});

test('update passes its lifecycle ticket to nested install', async (t) => {
  const { host } = await fixture(t);
  const plan = await buildInstallPlan(host);
  await install({ host });
  await fsp.appendFile(plan[0].target, '\noperator edit\n');
  const result = await update({ host, force: true });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Updated codex-bridge/);
});

test('a lifecycle ticket cannot run an action for another home', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  let actionRan = false;
  await withLifecycle(first.host, 'ticket-source', async (ticket) => {
    await assert.rejects(
      withLifecycle(second.host, 'ticket-target', () => { actionRan = true; }, { ticket }),
      /lifecycle ticket belongs to a different home/,
    );
  }, { createHome: true });
  assert.equal(actionRan, false);
});

test('a lifecycle ticket expires when its transaction ends', async (t) => {
  const { host } = await fixture(t);
  let ticket;
  await withLifecycle(host, 'ticket-expiry', (activeTicket) => { ticket = activeTicket; }, { createHome: true });
  let actionRan = false;
  await assert.rejects(
    withLifecycle(host, 'ticket-expired', () => { actionRan = true; }, { ticket }),
    /lifecycle ticket is no longer active/,
  );
  assert.equal(actionRan, false);
});

test('dry-run install answers while another process holds the home without taking its lock', { skip: childSkip }, async (t) => {
  const { root, host } = await fixture(t);
  const { child, firstLine } = await startHolder(root, host);
  try {
    assert.equal(await firstLine, 'ready');
    const result = await install({ host, dryRun: true, lifecycleWaitMs: 200 });
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Would create/);
  } finally {
    await killChild(child);
  }
});

test('uninstall and update of a host whose home does not exist create no home folder', async (t) => {
  const { host } = await fixture(t);
  assert.notEqual((await uninstall({ host })).exitCode, 0);
  assert.notEqual((await update({ host })).exitCode, 0);
  await assert.rejects(fsp.access(host.brandRoot), { code: 'ENOENT' });
});
