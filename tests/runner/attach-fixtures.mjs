/**
 * Shared run folders and console capture for the attach tests.
 *
 * Two files ask the same questions of one function — attach.test.mjs about waiting, and
 * attach-no-wait.test.mjs about the state-only call — and a second copy of these builders would
 * let the two drift until they described different runs while claiming to describe one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { attach } from '../../src/home/lib/runner/attach.mjs';

export function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * A pid that is certainly gone: a process this test waited for. A made-up number is not the
 * same test — the operating system is free to have handed it to someone else.
 */
export function deadPid() {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

export function run(runsRoot, name, status, files = {}) {
  const dir = path.join(runsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), body);
  return dir;
}

export const running = (repo, overrides = {}) => ({
  state: 'running',
  pid: process.pid,
  agent: 'codex-build',
  slug: 'async-start',
  task_hash: 'hash-1',
  order_id: 'order-1',
  repo,
  started_at: '2026-08-04T09:00:00.000Z',
  process_started_at: performance.timeOrigin,
  ...overrides,
});

export const order = (runsRoot, repo, overrides = {}) => ({
  runsRoot,
  repo,
  slug: 'async-start',
  taskHash: 'hash-1',
  orderId: 'order-1',
  ...overrides,
});

/** Runs attach() with console.log captured, so the printed contract can be asserted too. */
export async function attaching(args) {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(' '));
  try {
    return { code: await attach(args), lines };
  } finally {
    console.log = original;
  }
}
