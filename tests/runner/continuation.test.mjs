/** Verifies that a continuation is an explicit, current order from the orchestrator. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { continuationRefusal } from '../../src/home/lib/runner/continuation.mjs';
import { chainRuns, startedRuns, taskFingerprint } from '../../src/home/lib/write-meta.mjs';
import { parseTaskHeader } from '../../src/home/lib/task-header.mjs';
import { parseArgs } from '../../src/home/lib/runner/args.mjs';
import { orderTaskText } from './order-invocation.mjs';

function fixture(t) {
  const root = makeTempTree('continuation-');
  t.after(() => removeTempTree(root));
  return root;
}

function deadPid() {
  // raw argv: Node supplies a terminated pid for continuation liveness checks.
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

const grant = (runName) => parseTaskHeader(orderTaskText({
  grant: { kind: 'continue', run: runName, reason: 'LIMIT at step 3, tests unwritten' },
  task: 'Finish the ordered task.',
})).grant;

test('the closed continuation flag is refused before any run folder exists', (t) => {
  const runsRoot = fixture(t);
  // raw argv: Plan_63 D8 closes the continuation flag; a header grant alone is consent.
  assert.throws(() => parseArgs(['--agent', 'codex-review', '--continue']), (error) => {
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /unknown flag --continue/);
    assert.match(error.message, /the order belongs in the task-file header/);
    return true;
  });
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

test('a missing-folder grant refusal names the last outcome and ready grant line', (t) => {
  const runsRoot = fixture(t);
  const last = '2026-08-10_220535_plan25-2-install-table-two-roots';
  const reason = 'LIMIT at step 3, tests unwritten';
  run(runsRoot, last);
  fs.writeFileSync(
    path.join(runsRoot, last, 'meta.json'),
    JSON.stringify({ status: 'FAIL', reason: 'run stopped on its deadline' }) + '\n',
  );

  const message = continuationRefusal(
    runsRoot,
    [last],
    true,
    'order-1',
    grant('2026-08-10_220535_plan25-2-install-table-two-root'),
  );

  assert.match(message, new RegExp(`Last run: ${last}`));
  assert.match(message, /Outcome: FAIL — run stopped on its deadline/);
  assert.match(message, new RegExp(`Ready grant line: continue: ${last} — ${reason}`));
  assert.deepEqual(fs.readdirSync(runsRoot), [last]);
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

test('OW-049: adding a grant under a new order keeps the finished FAIL run in the chain', (t) => {
  const runsRoot = fixture(t);
  const repo = '/repo/ow-049';
  const task = 'Finish the ordered task.';
  run(runsRoot, 'A', {
    repo, slug: 'old-slug', order_id: 'o1', task_hash: taskFingerprint(task),
    started_at: '2026-10-03T00:01:00Z',
  });
  // Plan_75 D5: the grant lives in the header, and the hash sees only the body below it.
  const continued = parseTaskHeader(`continue: A — why\n\n${task}`);
  const continuationGrant = continued.grant;
  const chain = chainRuns(runsRoot, repo, 'new-slug', taskFingerprint(continued.body), 'o2', continuationGrant?.run);

  assert.equal(taskFingerprint(continued.body), taskFingerprint(task));
  assert.deepEqual(chain, ['A']);
  assert.equal(continuationRefusal(runsRoot, startedRuns(runsRoot, chain), true, 'o2', continuationGrant), null);
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
