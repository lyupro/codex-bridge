/** Guards the run-process identity decision and the single signal-0 implementation boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEARTBEAT_FILE,
  HEARTBEAT_STALE_MS,
} from '../src/home/lib/heartbeat.mjs';
import {
  IDENTITY_ALIVE,
  IDENTITY_DEAD,
  IDENTITY_FOREIGN,
  IDENTITY_UNVERIFIED,
  processIdentity,
} from '../src/home/lib/process-identity.mjs';
import { makeTempTree } from './temp-tree.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const now = Date.now();
const recordedStart = now - 10_000;

function runDir() {
  return makeTempTree('codex-process-identity-');
}

function status(overrides = {}) {
  return {
    pid: 42,
    started_at: new Date(now - 60_000).toISOString(),
    process_started_at: recordedStart,
    ...overrides,
  };
}

function heartbeat(dir, age) {
  const file = path.join(dir, HEARTBEAT_FILE);
  fs.writeFileSync(file, 'progress\n');
  const at = new Date(now - age);
  fs.utimesSync(file, at, at);
}

function permissionDenied() {
  const error = new Error('permission denied');
  error.code = 'EACCES';
  throw error;
}

test('pid plus fresh heartbeat is alive without an OS start-time probe', () => {
  const dir = runDir();
  heartbeat(dir, 1);
  let probes = 0;
  const identity = processIdentity({
    runDir: dir,
    status: status(),
    now,
    kill: () => {},
    probe: () => {
      probes += 1;
      return recordedStart;
    },
  });
  assert.equal(identity, IDENTITY_ALIVE);
  assert.equal(probes, 0);
});

test('pid plus stale heartbeat uses the injectable start-time probe', () => {
  const dir = runDir();
  heartbeat(dir, HEARTBEAT_STALE_MS + 1);
  let probes = 0;
  const identity = processIdentity({
    runDir: dir,
    status: status(),
    now,
    kill: () => {},
    probe: () => {
      probes += 1;
      return recordedStart;
    },
  });
  assert.equal(identity, IDENTITY_ALIVE);
  assert.equal(probes, 1);
});

test('pid plus no heartbeat uses the injectable start-time probe', () => {
  const dir = runDir();
  let probes = 0;
  const identity = processIdentity({
    runDir: dir,
    status: status(),
    now,
    kill: () => {},
    probe: () => {
      probes += 1;
      return recordedStart;
    },
  });
  assert.equal(identity, IDENTITY_ALIVE);
  assert.equal(probes, 1);
});

test('ESRCH is dead without probing when the heartbeat is missing', () => {
  const dir = runDir();
  let probes = 0;
  const identity = processIdentity({
    runDir: dir,
    status: status(),
    kill: () => {
      const error = new Error('no such process');
      error.code = 'ESRCH';
      throw error;
    },
    probe: () => {
      probes += 1;
      return recordedStart;
    },
  });
  assert.equal(identity, IDENTITY_DEAD);
  assert.equal(probes, 0);
});

test('EACCES with no heartbeat and no available probe is unverified', () => {
  const dir = runDir();
  const identity = processIdentity({
    runDir: dir,
    status: status(),
    kill: permissionDenied,
    probe: () => null,
  });
  assert.equal(identity, IDENTITY_UNVERIFIED);
});

test('EACCES with a later process start time is foreign', () => {
  const dir = runDir();
  const identity = processIdentity({
    runDir: dir,
    status: status(),
    kill: permissionDenied,
    probe: () => recordedStart + 60_000,
  });
  assert.equal(identity, IDENTITY_FOREIGN);
});

test('the Windows probe falls back to CIM for a SYSTEM-owned pid', { skip: process.platform !== 'win32' }, () => {
  const dir = runDir();
  const calls = [];
  const commandRunner = (command, args) => {
    calls.push({ command, args });
    assert.equal(command, 'powershell.exe');
    const script = args[3];
    assert.ok(script.indexOf('Get-Process') < script.indexOf('Get-CimInstance Win32_Process'));
    assert.ok((script.match(/ToUniversalTime\(\)\.ToString\('o'\)/g) || []).length >= 2);
    // This ISO timestamp is what the populated CIM fallback emits after Get-Process is empty.
    return { status: 0, error: null, stdout: `${new Date(recordedStart).toISOString()}\r\n` };
  };
  const identity = processIdentity({
    runDir: dir,
    status: status(),
    now,
    kill: permissionDenied,
    commandRunner,
  });
  assert.equal(identity, IDENTITY_ALIVE);
  assert.equal(calls.length, 1);
});

test('signal zero appears only in the process identity module', async () => {
  const excludedFiles = new Set(['src/home/lib/process-identity.mjs']);
  const violations = [];
  const patterns = ['src/**/*.mjs', 'cli/**/*.mjs', 'scripts/*.mjs'];
  const files = new Set();
  for (const pattern of patterns) {
    for await (const relative of fsp.glob(pattern, { cwd: root })) {
      files.add(relative.replaceAll('\\', '/'));
    }
  }
  for (const relative of [...files].sort()) {
    if (excludedFiles.has(relative)) continue;
    const source = await fsp.readFile(path.join(root, relative), 'utf8');
    if (/\bprocess\.kill\s*\(\s*[^,\n]+,\s*0\s*\)/.test(source)) violations.push(relative);
  }
  assert.deepEqual(violations, []);
});
