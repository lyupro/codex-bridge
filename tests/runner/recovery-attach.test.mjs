/** Plan_80 E18 O6b: anchor first, then one recorded automatic successor. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT } from '../../src/home/lib/runner/exit-codes.mjs';
import { readJsonFile } from '../../src/home/lib/runner/attach.mjs';
import { readyGrantLines } from '../../src/home/lib/runner/continuation.mjs';
import { attaching, deadPid, fixture, order, run, running } from './attach-fixtures.mjs';

const PARENT = '2026-10-03_180000_advise';
const CHILD = '2026-10-03_180200_automatic';
const PARENT_REPLY = 'FAIL — parent stalled';
const TRANSITION = "The run above stopped and was continued automatically in the same Codex thread; the verdict below is the continuation's.";

const saved = (status, reply) => ({
  'meta.json': JSON.stringify({ status }), 'reply.txt': `${reply}\n`,
});

function setup(t, { parent = {}, child = {}, parentFiles = saved('FAIL', PARENT_REPLY),
  childFiles = saved('OK', 'OK — child completed') } = {}) {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  const identity = { agent: 'codex-advisor', phase: 'advise', continued_from: 'scope-run' };
  const parentStatus = running(repo, {
    ...identity, state: 'finished', recovery: { automatic: true, child: CHILD }, ...parent,
  });
  const parentDir = run(runsRoot, PARENT, parentStatus, {
    'task-original.md': 'Frozen parent task\n', 'sentinel.bin': Buffer.from([0, 255, 13, 10]), ...parentFiles,
  });
  const childDir = run(runsRoot, CHILD, running(repo, {
    ...identity, started_at: '2026-10-03T18:02:00.000Z', resumed_from: PARENT,
    recovery: { automatic: true, attempt: 2, parent: PARENT }, ...child,
  }), childFiles);
  return { runsRoot, repo, parentDir, childDir, parentStatus };
}

function snapshot(dir) {
  return fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name))]);
}

async function checkedAttach(f, options = {}) {
  const before = snapshot(f.parentDir);
  const folders = fs.readdirSync(f.runsRoot).sort();
  try {
    return await attaching(order(f.runsRoot, f.repo, options));
  } finally {
    assert.deepEqual(snapshot(f.parentDir), before, 'attach must preserve every parent file and byte');
    assert.deepEqual(fs.readdirSync(f.runsRoot).sort(), folders, 'attach must not reserve another run');
  }
}

function assertTransition(f, lines) {
  assert.deepEqual(lines.slice(2, 5), [
    PARENT_REPLY, `CONTINUED=${f.childDir} from=${PARENT}`, TRANSITION,
  ]);
}

for (const [verdict, expected] of [['OK', EXIT.OK], ['LIMIT', EXIT.LIMIT], ['UNAVAILABLE', EXIT.UNAVAILABLE]]) {
  test(`cached parent FAIL and child ${verdict} answer in order with the child's exit code`, async (t) => {
    const f = setup(t, { childFiles: saved(verdict, `${verdict} — child verdict`) });
    let releases = 0;
    const { code, lines } = await checkedAttach(f, { beforeWait: () => { releases += 1; } });
    assert.equal(code, expected);
    assert.equal(releases, 0);
    assert.equal(lines[0], `ATTACH=${f.parentDir} order-id=order-1 started=${f.parentStatus.started_at}`);
    assert.equal(lines[1], `This is the answer of the previous run started at ${f.parentStatus.started_at}; no new work was started.`);
    assertTransition(f, lines);
    assert.deepEqual(lines.slice(5), [
      `ATTACH=${f.childDir} order-id=order-1 started=2026-10-03T18:02:00.000Z`,
      'This is the answer of the previous run started at 2026-10-03T18:02:00.000Z; no new work was started.',
      `${verdict} — child verdict`,
      ...(verdict === 'OK' ? [] : [readyGrantLines(f.runsRoot, [PARENT, CHILD])]),
    ]);
  });
}

test('a live child with noWait is pending under the child directory without releasing a claim', async (t) => {
  const f = setup(t, { childFiles: {} });
  let releases = 0;
  const { code, lines } = await checkedAttach(f, { noWait: true, beforeWait: () => { releases += 1; } });
  assert.equal(code, EXIT.PENDING);
  assert.equal(releases, 0);
  assertTransition(f, lines);
  assert.equal(lines[5], `ATTACH=${f.childDir} order-id=order-1 started=2026-10-03T18:02:00.000Z`);
  assert.match(lines[6], /^Run is still in progress; elapsed .+ Repeat the same command without --no-wait later to wait for its verdict\.$/);
  assert.equal(lines.length, 7);
});

test('a live child releases the claim once before waiting and returns its later verdict', async (t) => {
  const f = setup(t, { childFiles: {} });
  let releases = 0;
  const { code, lines } = await checkedAttach(f, { beforeWait: () => {
    releases += 1;
    const timer = setTimeout(() => {
      fs.writeFileSync(path.join(f.childDir, 'meta.json'), JSON.stringify({ status: 'LIMIT' }));
      fs.writeFileSync(path.join(f.childDir, 'reply.txt'), 'LIMIT — child answered later\n');
    }, 50);
    t.after(() => clearTimeout(timer));
  } });
  assert.equal(code, EXIT.LIMIT);
  assert.equal(releases, 1);
  assertTransition(f, lines);
  assert.equal(lines[5], `ATTACH=${f.childDir} order-id=order-1 started=2026-10-03T18:02:00.000Z`);
  assert.equal(lines[6], 'Attached to the run already in progress since 2026-10-03T18:02:00.000Z; no new work was started, and this invocation is waiting for its verdict.');
  assert.equal(lines[7], 'LIMIT — child answered later');
  assert.equal(lines.length, 8, 'a reply obtained by waiting must not append repair grants');
});

for (const childLive of [false, true]) {
  test(`a pointer published during the parent wait reaches a ${childLive ? 'live' : 'cached'} child`, async (t) => {
    const f = setup(t, { parent: { state: 'running', recovery: undefined }, parentFiles: {},
      childFiles: childLive ? {} : saved('OK', 'OK — child completed') });
    let releases = 0;
    let parentAfterWorker;
    const folders = fs.readdirSync(f.runsRoot).sort();
    const { code, lines } = await attaching(order(f.runsRoot, f.repo, { beforeWait: () => {
      releases += 1;
      const parentTimer = setTimeout(() => {
        fs.writeFileSync(path.join(f.parentDir, 'status.json'), JSON.stringify({
          ...f.parentStatus, state: 'finished', recovery: { automatic: true, child: CHILD },
        }));
        fs.writeFileSync(path.join(f.parentDir, 'meta.json'), JSON.stringify({ status: 'FAIL' }));
        fs.writeFileSync(path.join(f.parentDir, 'reply.txt'), `${PARENT_REPLY}\n`);
        // The worker owns these delayed writes; attach must preserve the resulting snapshot.
        parentAfterWorker = snapshot(f.parentDir);
      }, 50);
      t.after(() => clearTimeout(parentTimer));
      if (childLive) {
        const childTimer = setTimeout(() => {
          fs.writeFileSync(path.join(f.childDir, 'meta.json'), JSON.stringify({ status: 'OK' }));
          fs.writeFileSync(path.join(f.childDir, 'reply.txt'), 'OK — child completed\n');
        }, 750);
        t.after(() => clearTimeout(childTimer));
      }
    } }));
    assert.equal(code, EXIT.OK);
    assert.equal(releases, 1, 'parent and child waits share one claim release');
    assert.match(lines[1], /Attached to the run already in progress/);
    assertTransition(f, lines);
    assert.equal(lines.at(-1), 'OK — child completed');
    assert.deepEqual(snapshot(f.parentDir), parentAfterWorker);
    assert.deepEqual(fs.readdirSync(f.runsRoot).sort(), folders);
  });
}

test('noWait leaves a live anchor pending even when its child already has a reply', async (t) => {
  const f = setup(t, { parent: { state: 'running' }, parentFiles: {} });
  const { code, lines } = await checkedAttach(f, { noWait: true, beforeWait: () => assert.fail('no wait') });
  assert.equal(code, EXIT.PENDING);
  assert.equal(lines[0], `ATTACH=${f.parentDir} order-id=order-1 started=${f.parentStatus.started_at}`);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^Run is still in progress/);
});

test('a dead child without a verdict gets its own failure, leaving the parent unchanged', async (t) => {
  const f = setup(t, { child: { pid: deadPid() }, childFiles: {} });
  const { code, lines } = await checkedAttach(f, { noWait: true });
  assert.equal(code, EXIT.FAIL);
  assertTransition(f, lines);
  assert.match(lines[5], /run worker process died without recording a verdict/);
  assert.ok(lines[5].includes(f.childDir));
  assert.equal(readJsonFile(path.join(f.childDir, 'meta.json')).status, 'FAIL');
  assert.equal(fs.existsSync(path.join(f.childDir, 'reply.txt')), false);
});

test('a dead child with a verdict preserves it without inventing a saved reply', async (t) => {
  const f = setup(t, { child: { pid: deadPid() },
    childFiles: { 'meta.json': JSON.stringify({ status: 'UNAVAILABLE', reason: 'service unavailable' }) } });
  const before = snapshot(f.childDir);
  const { code, lines } = await checkedAttach(f);
  assert.equal(code, EXIT.UNAVAILABLE);
  assertTransition(f, lines);
  assert.equal(lines[5], `UNAVAILABLE — service unavailable\nRun: ${f.childDir}`);
  assert.deepEqual(snapshot(f.childDir), before);
});

test('an invalid child marker prints the unusable record and keeps the parent verdict', async (t) => {
  const f = setup(t, { child: { resumed_from: 'another-parent', recovery: { automatic: true, attempt: 2, parent: 'another-parent' } } });
  const { code, lines } = await checkedAttach(f);
  assert.equal(code, EXIT.FAIL);
  assert.equal(lines[2], PARENT_REPLY);
  assert.equal(lines[3], `Automatic continuation record of ${f.parentDir} is unusable (child-marker); the verdict above is final.`);
  assert.equal(lines.length, 4);
});

test('a never-started child keeps the parent verdict without announcing a transition', async (t) => {
  const f = setup(t, { child: { state: 'aborted_pre_start' } });
  const { code, lines } = await checkedAttach(f);
  assert.equal(code, EXIT.FAIL);
  assert.equal(lines[2], PARENT_REPLY);
  assert.equal(lines[3], `Automatic continuation ${f.childDir} never started Codex; the verdict above is final.`);
  assert.equal(lines[4], readyGrantLines(f.runsRoot, [PARENT]));
  assert.ok(lines[4].includes(`continue: ${PARENT} —`));
  assert.ok(lines[4].includes(`retry: ${PARENT} —`));
  assert.equal(lines.length, 5);
});

for (const [pointer, parent, notice] of [
  ['none', { recovery: undefined }, false],
  ['invalid', { recovery: { automatic: true, child: '../outside' } }, true],
]) {
  test(`a cached last-started anchor with ${pointer} successor prints its own repair grants`, async (t) => {
    const f = setup(t, { parent, child: { state: 'aborted_pre_start' } });
    const { code, lines } = await checkedAttach(f);
    assert.equal(code, EXIT.FAIL);
    assert.equal(lines[2], PARENT_REPLY);
    if (notice) {
      assert.equal(lines[3], `Automatic continuation record of ${f.parentDir} is unusable (child-name); the verdict above is final.`);
    }
    assert.equal(lines.at(-1), readyGrantLines(f.runsRoot, [PARENT]));
    assert.ok(lines.at(-1).includes(`continue: ${PARENT} —`));
    assert.ok(lines.at(-1).includes(`retry: ${PARENT} —`));
    assert.equal(lines.length, notice ? 5 : 4);
  });
}

test('cached parent FAIL and cached started child FAIL print repair grants after the child reply', async (t) => {
  const f = setup(t, { child: { state: 'finished' }, childFiles: saved('FAIL', 'FAIL — child stalled') });
  const { code, lines } = await checkedAttach(f);
  assert.equal(code, EXIT.FAIL);
  assertTransition(f, lines);
  assert.deepEqual(lines.slice(5), [
    `ATTACH=${f.childDir} order-id=order-1 started=2026-10-03T18:02:00.000Z`,
    'This is the answer of the previous run started at 2026-10-03T18:02:00.000Z; no new work was started.',
    'FAIL — child stalled',
    readyGrantLines(f.runsRoot, [PARENT, CHILD]),
  ]);
  assert.ok(lines.at(-1).includes(`continue: ${CHILD} —`));
  assert.ok(lines.at(-1).includes(`retry: ${CHILD} —`));
});

test('cached child OK prints no repair grants after either saved reply', async (t) => {
  const f = setup(t, { child: { state: 'finished' } });
  const { code, lines } = await checkedAttach(f);
  assert.equal(code, EXIT.OK);
  assertTransition(f, lines);
  assert.equal(lines.at(-1), 'OK — child completed');
  assert.equal(lines.length, 8);
  assert.doesNotMatch(lines.join('\n'), /(?:continue|retry|resume):/);
});

test('automatic resumed_from ancestry does not consume a manual resume grant', async (t) => {
  const f = setup(t);
  const { code, lines } = await checkedAttach(f, { isContinue: true, resumeRun: PARENT });
  assert.equal(code, null);
  assert.deepEqual(lines, []);
});

for (const [label, parent, child, selector] of [
  ['continue', {}, {}, { grantRun: 'scope-run' }],
  ['retry', { retry_of: 'failed-run' }, { retry_of: 'failed-run' }, { retryRun: 'failed-run' }],
  ['resume', { resumed_from: 'failed-run' }, {}, { resumeRun: 'failed-run' }],
]) {
  test(`a repeated ${label} grant anchors on its manual run before following the child`, async (t) => {
    const f = setup(t, { parent, child });
    const { code, lines } = await checkedAttach(f, { isContinue: true, ...selector });
    assert.equal(code, EXIT.OK);
    assertTransition(f, lines);
    assert.equal(lines.at(-1), 'OK — child completed');
  });
}

test('an automatic child without a parent pointer is never inferred from folder order', async (t) => {
  const f = setup(t, { parent: { recovery: undefined } });
  const { code, lines } = await checkedAttach(f);
  assert.equal(code, EXIT.FAIL);
  assert.equal(lines[2], PARENT_REPLY);
  assert.equal(lines.length, 3);
});

test('a successor is answered once even when it records another valid automatic child', async (t) => {
  const f = setup(t, { child: { recovery: { automatic: true, attempt: 2, parent: PARENT, child: 'third' } } });
  const childStatus = readJsonFile(path.join(f.childDir, 'status.json'));
  run(f.runsRoot, 'third', {
    ...childStatus, resumed_from: CHILD, recovery: { automatic: true, attempt: 2, parent: CHILD },
  }, saved('LIMIT', 'LIMIT — forbidden second hop'));
  const { code, lines } = await checkedAttach(f);
  assert.equal(code, EXIT.OK);
  assertTransition(f, lines);
  assert.equal(lines.filter((line) => line.startsWith('CONTINUED=')).length, 1);
  assert.equal(lines.at(-1), 'OK — child completed');
});
