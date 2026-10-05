/** Plan_75 D1: the 2026-10-03 TradeForge capacity failure needs one grant for the same pass. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { orderTaskText } from './order-invocation.mjs';
import { parseArgs } from '../../src/home/lib/runner/args.mjs';
import {
  CONTINUATION_ORDER_INPUT, RETRY_ORDER_INPUT, ORDER_AGENTS, orderLabelsFor,
} from '../../src/home/lib/order-schema.mjs';
import { splitGrantValue } from '../../src/home/lib/order-values.mjs';
import { parseTaskHeader } from '../../src/home/lib/task-header.mjs';
import {
  continuationRefusal, retryRefusal, readyGrantLines,
} from '../../src/home/lib/runner/continuation.mjs';

function fixture(t) {
  const root = makeTempTree('retry-grant-');
  t.after(() => removeTempTree(root));
  return root;
}

function run(root, name, status, meta) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), `${JSON.stringify(status)}\n`);
  if (meta !== null) fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta)}\n`);
  return dir;
}

const finished = { state: 'finished', order_id: 'o' };
const grant = (kind, runName) => parseTaskHeader(orderTaskText({
  order: { 'order id': 'o' },
  grant: { kind, run: runName, reason: 'model at capacity, same pass again' },
})).grant;
const dead = () => false;
const unexpectedLiveness = () => assert.fail('an earlier retry gate must refuse before liveness');
const noQuota = (message) => assert.match(message, /The run folder was not created; quota was not spent\.$/);

test('retry input has the continuation shape and is inside every list with continue, right after it', () => {
  assert.deepEqual(Object.keys(RETRY_ORDER_INPUT), Object.keys(CONTINUATION_ORDER_INPUT));
  assert.equal(RETRY_ORDER_INPUT.label, 'retry');
  assert.match(RETRY_ORDER_INPUT.explanation, /^The failed run this pass repeats, followed by why the orchestrator pays for the same pass again/);
  assert.equal(RETRY_ORDER_INPUT.example, '2026-10-03_172017_cc-d66-advisor — model at capacity, same pass again');
  assert.equal(RETRY_ORDER_INPUT.conditional, 'when this pass continues or repeats a named run');
  assert.ok(Object.isFrozen(RETRY_ORDER_INPUT));
  for (const agent of ORDER_AGENTS) {
    const inputs = orderLabelsFor(agent);
    const continuationIndex = inputs.findIndex((input) => input.label === 'continue');
    if (continuationIndex === -1) continue;
    assert.deepEqual(inputs[continuationIndex + 1], {
      ...RETRY_ORDER_INPUT, required: false, conditional: true, optional: false,
    }, agent);
    assert.equal(inputs.filter((input) => input.label === 'retry').length, 1, agent);
  }
});

test('header parsing returns no grant without a grant label', () => {
  for (const text of ['', 'Repeat the failed pass.', 'retry this pass']) {
    assert.equal(parseTaskHeader(text).grant, null);
  }
  for (const value of [undefined, null]) assert.equal(splitGrantValue(value), null);
});

test('header grants distinguish the next pass from the repeated failed pass', () => {
  assert.deepEqual(parseTaskHeader('continue: S — advise after scope').grant, {
    kind: 'continue', run: 'S', reason: 'advise after scope',
  });
  assert.deepEqual(parseTaskHeader('retry: A — capacity failure').grant, {
    kind: 'retry', run: 'A', reason: 'capacity failure',
  });
});

test('header parsing refuses both grants regardless of their order or run names', () => {
  for (const text of [
    'continue: S — next pass\nretry: A — same pass',
    'retry: A — same pass\r\ncontinue: A — next pass',
  ]) {
    assert.ok(parseTaskHeader(text).problems.some(({ reason }) =>
      reason === 'continue and retry cannot both be present; keep exactly one grant label'));
  }
  // Plan_63 D9: the retired loose reader accepted decoration; the strict header refuses it.
  assert.match(parseTaskHeader('- *retry*: A — same pass\r\ncontinue: A — next pass')
    .problems[0].reason, /misplaced retry metadata/);
});

test('retry and continuation share run/reason separators through the header value grammar', () => {
  for (const value of ['X — why', 'X - why', 'X: why']) {
    assert.deepEqual(splitGrantValue(value), { run: 'X', reason: 'why' });
    for (const kind of ['continue', 'retry']) {
      assert.deepEqual(parseTaskHeader(`${kind}: ${value}`).grant, { kind, run: 'X', reason: 'why' });
    }
  }
  assert.match(parseTaskHeader('- *retry*: X — why').problems[0].reason, /misplaced retry metadata/);
});

test('grant placeholders and incomplete run/reason pairs remain null', () => {
  for (const label of ['continue', 'retry']) {
    for (const value of ['', '<run> — why', 'X — <why>', 'TODO — why', 'X — TBD', 'X', 'X — ']) {
      assert.equal(splitGrantValue(value), null, value);
      assert.equal(parseTaskHeader(`${label}: ${value}`).grant, null, `${label}: ${value}`);
    }
  }
});

test('the retired continuation flag is refused before a retry can start', () => {
  // raw argv: Plan_63 D8 closes the old flag family; the header grant alone authorizes a retry.
  assert.throws(() => parseArgs(['--continue']), /unknown flag .*the order belongs in the task-file header/);
});

test('retry gate b: the grant must name a bare existing run directory', (t) => {
  const root = fixture(t);
  run(root, 'A', finished, { status: 'FAIL' });
  fs.writeFileSync(path.join(root, 'file'), 'not a run folder\n');
  for (const name of ['missing', '.', '..', '../A', path.join(root, 'A'), 'file']) {
    const message = retryRefusal(root, [name], true, 'o', grant('retry', name), unexpectedLiveness);
    assert.match(message, /not a bare existing run folder/);
    noQuota(message);
  }
  assert.deepEqual(fs.readdirSync(root).sort(), ['A', 'file']);
});

test('retry gate c: only the last run matches, before checking its order or verdict', (t) => {
  const root = fixture(t);
  run(root, 'S', { order_id: 'different' }, null);
  run(root, 'A', finished, { status: 'FAIL' });
  const message = retryRefusal(root, ['S', 'A'], true, 'o', grant('retry', 'S'), unexpectedLiveness);
  assert.match(message, /not the LAST run/);
  assert.match(message, /single-use/);
  noQuota(message);
  noQuota(retryRefusal(root, [], true, 'o', grant('retry', 'A'), unexpectedLiveness));
});

test('retry gate d: repeats only the same order, and refuses pre-order runs', (t) => {
  const root = fixture(t);
  for (const [name, status] of [
    ['other', { order_id: 'another-order' }],
    ['legacy', {}],
    ['blank', { order_id: '  ' }],
  ]) {
    run(root, name, status, null);
    const message = retryRefusal(root, [name], true, 'o', grant('retry', name), unexpectedLiveness);
    assert.match(message, /order_id .* differs from order o/);
    assert.match(message, /start a new order/);
    noQuota(message);
  }
});

test('retry gate e: a missing verdict refuses before liveness', (t) => {
  const root = fixture(t);
  for (const [name, meta] of [['missing', null], ['empty', {}]]) {
    run(root, name, finished, meta);
    const message = retryRefusal(root, [name], true, 'o', grant('retry', name), unexpectedLiveness);
    assert.match(message, /no finished verdict/);
    assert.match(message, /Repeat without `retry:` to attach/);
    noQuota(message);
  }
});

test('retry gate e: a possibly live worker refuses even an OK verdict before gate f', (t) => {
  const root = fixture(t);
  for (const verdict of ['FAIL', 'OK']) {
    const runDir = run(root, verdict, finished, { status: verdict });
    let calls = 0;
    const message = retryRefusal(root, [verdict], true, 'o', grant('retry', verdict), (input) => {
      calls += 1;
      assert.deepEqual(input, { runDir, status: finished });
      return true;
    });
    assert.equal(calls, 1);
    assert.match(message, /worker may still be alive and writing/);
    assert.doesNotMatch(message, /ended OK/);
    noQuota(message);
  }
});

test('retry gate f: a finished OK run needs a continuation, not a retry', (t) => {
  const root = fixture(t);
  run(root, 'S', finished, { status: 'OK' });
  const message = retryRefusal(root, ['S'], true, 'o', grant('retry', 'S'), dead);
  assert.match(message, /ended OK/);
  assert.match(message, /use continue: for the next pass/);
  noQuota(message);
});

test('retry gate g: finished FAIL, LIMIT and UNAVAILABLE runs can repeat the same pass', (t) => {
  const root = fixture(t);
  for (const verdict of ['FAIL', 'LIMIT', 'UNAVAILABLE']) {
    run(root, verdict, finished, { status: verdict });
    assert.equal(retryRefusal(root, [verdict], true, 'o', grant('retry', verdict), dead), null);
  }
});

test('TradeForge: the failed advise can be retried after scope and advise spent the order', (t) => {
  const root = fixture(t);
  run(root, 'S', finished, { status: 'OK' });
  run(root, 'A', { ...finished, continued_from: 'S' }, {
    status: 'FAIL', reason: 'Selected model is at capacity…',
  });
  const chain = ['S', 'A'];
  assert.equal(retryRefusal(root, chain, true, 'o', parseTaskHeader('retry: A — model at capacity').grant, dead), null);
  assert.match(retryRefusal(root, chain, true, 'o', grant('retry', 'S'), dead), /not the LAST run/);
  const message = continuationRefusal(root, chain, true, 'o', grant('continue', 'A'));
  assert.match(message, /already spent its allowed continuation/);
  assert.match(message, /Ready retry line: retry: A — Selected model is at capacity… \(repeats that pass under order o\)\./);
  noQuota(message);
  run(root, 'R', { ...finished, retry_of: 'A' }, { status: 'FAIL' });
  assert.match(retryRefusal(root, [...chain, 'R'], true, 'o', grant('retry', 'A'), dead), /not the LAST run/);
});

test('an OK retry does not enter the spent-pass list: S and A remain the two passes', (t) => {
  const root = fixture(t);
  run(root, 'S', finished, { status: 'OK' });
  run(root, 'A', { ...finished, continued_from: 'S' }, { status: 'FAIL' });
  run(root, 'R', { ...finished, retry_of: 'A' }, { status: 'OK' });
  const message = continuationRefusal(root, ['S', 'A', 'R'], true, 'o', grant('continue', 'R'));
  assert.match(message, /already spent its allowed continuation/);
  const spent = message.split('. Last run:')[0];
  assert.ok(spent.includes(path.join(root, 'S')));
  assert.ok(spent.includes(path.join(root, 'A')));
  assert.equal(spent.includes(path.join(root, 'R')), false);
  noQuota(message);
});

test('a retry adds no continuation count when only one original pass carries this order', (t) => {
  const root = fixture(t);
  run(root, 'S', finished, { status: 'OK' });
  run(root, 'R', { ...finished, retry_of: 'S' }, { status: 'OK' });
  assert.equal(continuationRefusal(root, ['S', 'R'], true, 'o', grant('continue', 'R')), null);
});

test('an empty retry_of still counts as a new pass', (t) => {
  const root = fixture(t);
  run(root, 'S', finished, { status: 'OK' });
  for (const retryOf of ['', '  ']) {
    run(root, 'A', { ...finished, retry_of: retryOf }, { status: 'FAIL' });
    assert.match(continuationRefusal(root, ['S', 'A'], true, 'o', grant('continue', 'A')), /already spent/);
  }
});

test('readyGrantLines: an OK last run offers only the next pass', (t) => {
  const root = fixture(t);
  run(root, 'S', finished, { status: 'OK', reason: 'scope accepted' });
  assert.equal(readyGrantLines(root, ['S']), 'Ready grant line: continue: S — scope accepted.');
});

test('readyGrantLines: a finished non-OK last run also names the retry and its order', (t) => {
  const root = fixture(t);
  for (const status of ['FAIL', 'LIMIT', 'UNAVAILABLE']) {
    run(root, 'A', finished, { status, reason: 'model at capacity' });
    assert.equal(readyGrantLines(root, ['A']),
      'Ready grant line: continue: A — model at capacity. ' +
      'Ready retry line: retry: A — model at capacity (repeats that pass under order o).');
  }
});

test('readyGrantLines: a failed run without order_id is not advertised for a retry gate d would refuse', (t) => {
  const root = fixture(t);
  const { order_id: _dropped, ...preOrder } = finished;
  run(root, 'A', preOrder, { status: 'FAIL', reason: 'model at capacity' });
  assert.equal(readyGrantLines(root, ['A']), 'Ready grant line: continue: A — model at capacity.');
});

test('readyGrantLines: no verdict never advertises a retry, even with a failed state', (t) => {
  const root = fixture(t);
  run(root, 'A', { ...finished, state: 'failed', reason: 'not started' }, null);
  assert.doesNotMatch(readyGrantLines(root, ['A']), /Ready retry line/);
  assert.equal(readyGrantLines(root, []), 'Ready grant line: none (there is no run to continue).');
});

test('every continuation refusal includes the ready retry when the last run failed', (t) => {
  const root = fixture(t);
  run(root, 'S', finished, { status: 'OK' });
  run(root, 'A', finished, { status: 'FAIL', reason: 'capacity' });
  // Plan_63 D8: without a header grant there is no continuation; flag/grant mismatches cannot occur.
  assert.equal(continuationRefusal(root, ['S', 'A'], false, 'o', null), null);
  for (const input of [grant('continue', 'missing'), grant('continue', 'S'), grant('continue', 'A')]) {
    const message = continuationRefusal(root, ['S', 'A'], Boolean(input), 'o', input);
    assert.match(message, /Ready retry line: retry: A — capacity \(repeats that pass under order o\)/);
    noQuota(message);
  }
  run(root, 'A', { ...finished, state: 'running' }, { status: 'FAIL', reason: 'capacity' });
  assert.match(continuationRefusal(root, ['A'], true, 'o', grant('continue', 'A')), /Ready retry line: retry: A/);
});
