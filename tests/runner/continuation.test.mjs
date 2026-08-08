/** Verifies that a continuation is an explicit, current order from the orchestrator. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { continuationRefusal } from '../../src/runner/continuation.mjs';
import { startedRuns } from '../../src/write-meta.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function deadPid() {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

function run(runsRoot, name, overrides = {}, withVerdict = true) {
  const dir = path.join(runsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'status.json'),
    `${JSON.stringify(
      {
        state: 'finished',
        pid: deadPid(),
        order_id: 'order-1',
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
  if (withVerdict) fs.writeFileSync(path.join(dir, 'meta.json'), '{"status":"FAIL"}\n');
  return dir;
}

const grant = (runName) => ({ run: runName, reason: 'LIMIT at step 3, tests unwritten' });

test('--continue without a grant is refused before any run folder exists', (t) => {
  const runsRoot = fixture(t);
  const message = continuationRefusal(runsRoot, [], true, 'order-1');

  assert.match(message, /orchestrator/);
  assert.match(message, /Example: `continue:/);
  assert.match(message, /Action:/);
  assert.deepEqual(fs.readdirSync(runsRoot), []);
});

test('a grant naming a missing run is refused in the project runs directory', (t) => {
  const runsRoot = fixture(t);
  const missing = '2026-08-05_092913_plan14-build';
  const message = continuationRefusal(runsRoot, [missing], true, 'order-1', grant(missing));

  assert.match(message, new RegExp(missing));
  assert.match(message, new RegExp(runsRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(message, /Example: `continue:/);
  assert.match(message, /Action:/);
  assert.deepEqual(fs.readdirSync(runsRoot), []);
});

test('a grant for an earlier chain run is refused as single-use', (t) => {
  const runsRoot = fixture(t);
  const first = '2026-08-05_090000_plan14-build';
  const second = '2026-08-05_092913_plan14-build';
  run(runsRoot, first);
  run(runsRoot, second);

  const message = continuationRefusal(runsRoot, [first, second], true, 'order-1', grant(first));

  assert.match(message, /not the LAST run/);
  assert.match(message, /single-use/);
  assert.match(message, /old grant stops matching by itself/);
  assert.match(message, /Example: `continue:/);
  assert.match(message, /Action:/);
  assert.deepEqual(fs.readdirSync(runsRoot).sort(), [first, second]);
});

test('an explicit grant for the current finished run permits the first continuation', (t) => {
  const runsRoot = fixture(t);
  const name = '2026-08-05_092913_plan14-build';
  run(runsRoot, name);

  assert.equal(continuationRefusal(runsRoot, [name], true, 'order-1', grant(name)), null);
});

test('a retroactive pre-start folder leaves the same order eligible for its first launch', (t) => {
  const runsRoot = fixture(t);
  const name = '2026-08-05_092913_plan14-build';
  run(runsRoot, name, { state: 'failed' }, false);
  fs.writeFileSync(
    path.join(runsRoot, name, 'meta.json'),
    JSON.stringify({ exit: null, session_id: null, events_bytes: 0, stderr_bytes: 0, tokens_reported: false }),
  );

  const started = startedRuns(runsRoot, [name]);
  assert.deepEqual(started, []);
  assert.equal(continuationRefusal(runsRoot, started, false, 'order-1'), null);
});
