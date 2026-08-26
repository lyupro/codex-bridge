/** Verifies the CLI still recognises itself when it is started through a link or an odd spelling. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { isInvokedDirectly } from '../../cli/invoked-directly.mjs';

const run = promisify(execFile);
const BIN = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'bin', 'codex-bridge.mjs');

test('a module started as itself is invoked directly', () => {
  assert.equal(isInvokedDirectly(BIN, pathToFileURL(BIN).href), true);
});

test('an unnormalised spelling of the same file still counts', () => {
  const detoured = path.join(path.dirname(BIN), '..', 'bin', 'codex-bridge.mjs');
  assert.equal(isInvokedDirectly(detoured, pathToFileURL(BIN).href), true);
});

test('another file does not count', () => {
  assert.equal(isInvokedDirectly(path.join(path.dirname(BIN), 'nothing.mjs'), pathToFileURL(BIN).href), false);
});

test('a missing argv entry does not count', () => {
  assert.equal(isInvokedDirectly(undefined, pathToFileURL(BIN).href), false);
});

test('a path that cannot be resolved falls back to plain resolution', () => {
  const absent = path.join(os.tmpdir(), 'codex-bridge-not-here', 'bin.mjs');
  assert.equal(isInvokedDirectly(absent, pathToFileURL(absent).href), true);
});

test('the CLI prints its version when started through a symlink', async (t) => {
  // `npm i -g .` links the global package at the clone, so argv[1] names the link while the module
  // resolves to its target. Comparing the two as written made the CLI exit 0 in silence — and a
  // guard that prints nothing permits everything it was installed to refuse.
  const root = makeTempTree('bridge-link-');
  t.after(() => removeTempTree(root));
  const link = path.join(root, 'codex-bridge.mjs');
  try {
    await fs.symlink(BIN, link, 'file');
  } catch (err) {
    // Creating a symlink on Windows needs administrator rights or developer mode; the unit cases
    // above still cover the comparison itself.
    t.skip(`symlinks unavailable: ${err.code}`);
    return;
  }
  const { stdout } = await run(process.execPath, [link, '--version']);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});
