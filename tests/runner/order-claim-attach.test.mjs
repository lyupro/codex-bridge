/** Guards Plan_60 D4c admission after the 2026-09-24 same-order double-billing incident. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { attach } from '../../src/home/lib/runner/attach.mjs';
import { unclaimedRaceRefusal } from '../../src/home/lib/runner/order-claim.mjs';
import { attaching, fixture, order, run, running } from './attach-fixtures.mjs';

test('a live attach awaits beforeWait exactly once before announcing or waiting', async (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'repo');
  const dir = run(root, '2026-08-04_090000_async-start', running(repo));
  let calls = 0;
  let released = false;
  const lines = [];
  const original = console.log;
  let answering;
  console.log = (...parts) => {
    assert.equal(released, true, 'the worker needs the claim before live attach announces its wait');
    lines.push(parts.join(' '));
  };
  try {
    const code = await attach(order(root, repo, {
      beforeWait: async () => {
        calls += 1;
        assert.equal(fs.existsSync(path.join(dir, 'reply.txt')), false);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(lines, []);
        released = true;
        answering = setTimeout(() => {
          fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ status: 'OK' }));
          fs.writeFileSync(path.join(dir, 'reply.txt'), 'OK — admitted after release\n');
        }, 10);
      },
    }));
    assert.equal(code, 0);
    assert.equal(calls, 1);
    assert.match(lines[1], /waiting for its verdict/);
    assert.equal(lines[2], 'OK — admitted after release');
  } finally {
    console.log = original;
    clearTimeout(answering);
  }
});

test('a live --no-wait attach does not call beforeWait', async (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'repo');
  run(root, '2026-08-04_090000_async-start', running(repo));
  let calls = 0;
  const { code } = await attaching(order(root, repo, {
    noWait: true, beforeWait: () => { calls += 1; },
  }));
  assert.equal(code, 4);
  assert.equal(calls, 0);
});

test('a saved reply attach does not call beforeWait', async (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'repo');
  run(root, '2026-08-04_090000_async-start', running(repo), {
    'meta.json': JSON.stringify({ status: 'OK' }), 'reply.txt': 'OK — saved\n',
  });
  let calls = 0;
  const { code } = await attaching(order(root, repo, { beforeWait: () => { calls += 1; } }));
  assert.equal(code, 0);
  assert.equal(calls, 0);
});

function raceOptions(projectRunsRoot, repoRoot, chainBefore) {
  return { projectRunsRoot, repoRoot, slug: 'async-start', taskHash: 'hash-1', orderId: 'order-1', chainBefore };
}

test('an unsupported-platform race refuses a newly registered same-order run for free', (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'repo');
  const prior = '2026-08-04_080000_async-start';
  run(root, prior, running(repo));
  const appeared = '2026-08-04_090000_async-start';
  run(root, appeared, running(repo, { task_hash: 'another-hash', slug: 'another-slug' }));
  assert.equal(unclaimedRaceRefusal(raceOptions(root, repo, [prior])),
    `another launch of order id "order-1" registered ${appeared} while this one was preparing; `
      + 'repeat the same command — it attaches to that run. The run folder was not created; quota was not spent.');
  assert.deepEqual(fs.readdirSync(root), [prior, appeared]);
});

test('no newly registered same-order run means no race refusal', (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'repo');
  assert.equal(unclaimedRaceRefusal(raceOptions(root, repo, [])), null);
  const prior = '2026-08-04_090000_async-start';
  run(root, prior, running(repo));
  assert.equal(unclaimedRaceRefusal(raceOptions(root, repo, [prior])), null);
});

test('a newly registered run of another exact order id is not a race refusal', (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'repo');
  for (const [index, orderId] of ['order-2', 'Order-1'].entries()) {
    run(root, `2026-08-04_09000${index}_async-start`, running(repo, { order_id: orderId }));
  }
  assert.equal(unclaimedRaceRefusal(raceOptions(root, repo, [])), null);
});

test('launcher holds the claim from before abandonment until worker registration, including refusals', () => {
  // Plan_60 D4c: a late abandoned write could close a live paid run; guard the placement itself.
  const source = fs.readFileSync(new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url), 'utf8');
  const markers = [
    'const projectRunsRoot = resolveProjectRunsDir(',
    'const claim = await acquireOrderClaim(',
    'if (claim.busy) die(orderClaimBusyText(opts.orderId, claim.holder), EXIT.FAIL)',
    'try {',
    'markAbandoned(projectRunsRoot,',
    'const drift = abandonedBranchDrift(',
    'const gate = await passGate(',
    'const availability = await codexAvailabilityRefusal(',
    'const sandboxProbe = await probeSandbox(',
    'const preflightError = preflightRefusal(',
    'retention = cleanupRetention(',
    'if (claim.unsupported) {',
    'const text = unclaimedRaceRefusal(',
    'const runDir = makeRunDir(',
    'writeStatus(runDir, {',
    'const worker = spawn(',
    'writeStatus(runDir, { pid: worker.pid,',
    '} finally {',
    'await claim.release();',
  ];
  let position = source.indexOf(markers[0]);
  assert.notEqual(position, -1);
  for (const marker of markers.slice(1)) {
    const next = source.indexOf(marker, position + 1);
    assert.ok(next > position, `claim lifetime ordering lost at ${marker}`);
    position = next;
  }
  assert.match(source, /beforeWait: claim\.release/);
  assert.match(source, /if \(text\) die\(text, EXIT\.FAIL\);\s*}\s*const runDir = makeRunDir\(/);
});
