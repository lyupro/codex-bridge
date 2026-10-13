/** Plan_79 B4e: claim, owner and availability messages keep their bytes under D3/D4/D6. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from './temp-tree.mjs';
import { ORDER_RULES, orderRuleMessage } from '../src/home/lib/order-rules.mjs';
import { RULES as CALL_RULES } from '../src/home/lib/order-rules/call.mjs';
import { RULES as HEADER_RULES } from '../src/home/lib/order-rules/header.mjs';
import { ORDER_DIAGNOSTICS, orderDiagnosticMessage } from '../src/home/lib/order-diagnostics.mjs';
import { orderInputName } from '../src/home/lib/order-schema.mjs';
import {
  acquireOrderClaim, orderClaimAddress, orderClaimHolderText, orderClaimBusyText, unclaimedRaceRefusal,
} from '../src/home/lib/runner/order-claim.mjs';
import { orderOwnerConflictText } from '../src/home/lib/runner/order-owner.mjs';
import { probeCodexAvailability } from '../src/home/lib/runner/codex-availability.mjs';
import { ADMISSION_FILES } from './order-guard/admission-files.mjs';
import { checkRefusalSites } from './order-guard/refusal-checker.mjs';

// Plan_79 B4e: literal expectations copy the original sites, independently of the registry builders.
const holder = { role: 'launcher', pid: 123, acquiredAt: '2026-10-04T12:00:00.000Z' };
const claimMessages = [
  [{ variant: 'holder-unverified' }, 'a process that did not answer (unverified)'],
  [{ variant: 'holder', ...holder }, 'launcher pid 123 since 2026-10-04T12:00:00.000Z'],
  [{ variant: 'holder', ...holder, role: 'worker' }, 'worker pid 123 since 2026-10-04T12:00:00.000Z'],
  [{ variant: 'busy', orderId: 'Order-A',
    holderDescription: orderRuleMessage('order-launch-exclusive', { variant: 'holder-unverified' }) },
  'order id "Order-A" is being launched by a process that did not answer (unverified); repeat the same command later — ' +
    'it attaches to that run instead of starting another.'],
  [{ variant: 'busy', orderId: 'Order-A',
    holderDescription: orderRuleMessage('order-launch-exclusive', { variant: 'holder', ...holder }) },
  'order id "Order-A" is being launched by launcher pid 123 since 2026-10-04T12:00:00.000Z; ' +
    'repeat the same command later — it attaches to that run instead of starting another.'],
  [{ variant: 'busy', orderId: 'Order-A',
    holderDescription: orderRuleMessage('order-launch-exclusive', { variant: 'holder', ...holder, role: 'worker' }) },
  'order id "Order-A" is being launched by worker pid 123 since 2026-10-04T12:00:00.000Z; ' +
    'repeat the same command later — it attaches to that run instead of starting another.'],
  [{ variant: 'race', orderId: 'Order-A', run: '2026-10-04_120000_new-run' },
    'another launch of order id "Order-A" registered 2026-10-04_120000_new-run while this one was preparing; ' +
      'repeat the same command — it attaches to that run.'],
];
const ownerValues = {
  orderId: 'order-1', ownerDir: 'C:/runs/2026-08-15_090000_plan42-run2',
  slug: 'plan42-run2', startedAt: '2026-08-15T09:00:00.000Z',
};
const ownerMessages = [
  [{ ...ownerValues, violation: 'different-task', labelName: orderInputName('order id') },
    'Order id collision: "order-1" already belongs to run folder C:/runs/2026-08-15_090000_plan42-run2 ' +
      '(slug plan42-run2, started_at 2026-08-15T09:00:00.000Z) with a different task. ' +
      'Use a new order id (`order id:`), or a continue:/retry: header line if this is another pass of that order.'],
  [{ ...ownerValues, violation: 'predates-hash-scheme', hashScheme: 2 },
    'Order id collision: "order-1" already belongs to run folder C:/runs/2026-08-15_090000_plan42-run2 ' +
      '(slug plan42-run2, started_at 2026-08-15T09:00:00.000Z), recorded before the task header (hash scheme 2), ' +
      'so its task cannot be compared. Its answer is already on disk in that folder ' +
      '(codex-bridge read "C:/runs/2026-08-15_090000_plan42-run2"). ' +
      'Another pass of that order needs a continue:/retry: header line; a new task needs a new order id.'],
];
const diagnosticMessages = [
  ['order-claim-input-valid', { violation: 'order-id' }, 'internal', 'orderId must be a non-empty string'],
  ['order-claim-input-valid', { violation: 'role' }, 'internal', 'role must be launcher or worker'],
  ['project-runs-folder-required', { projectRunsRoot: 'C:/missing/runs' }, 'filesystem',
    'project runs folder does not exist: C:/missing/runs'],
  ['codex-availability-detail', { variant: 'path-miss' }, 'host-state',
    'codex could not be resolved in this process PATH; readiness is unconfirmed'],
  ['codex-availability-detail', { variant: 'exit-status', command: 'codex --version', status: 3 }, 'host-state',
    'codex --version exited 3'],
  ['codex-availability-detail', { variant: 'exit-status', command: 'codex login status', status: null }, 'host-state',
    'codex login status exited null'],
  ['codex-availability-detail', { variant: 'failed' }, 'host-state', 'codex availability probe failed'],
  ['codex-availability-detail', { variant: 'logged-out' }, 'host-state', 'codex login status: Not logged in'],
  ['codex-availability-detail', { variant: 'message', message: 'system error: access denied' }, 'host-state',
    'system error: access denied'],
];

for (const [key, cases] of [['order-launch-exclusive', claimMessages], ['order-id-owner', ownerMessages]]) {
  for (const [values, expected] of cases) {
    test(`${key} ${values.variant ?? values.violation} ${values.role ?? ''} preserves literal text`, () => {
      assert.equal(orderRuleMessage(key, values), expected);
      assert.equal(ORDER_RULES[key].message(values), expected);
    });
  }
}
for (const [key, values, category, expected] of diagnosticMessages) {
  test(`${key} ${values.variant ?? values.violation ?? ''} preserves its ${category} diagnostic`, () => {
    assert.equal(orderDiagnosticMessage(key, values), expected);
    assert.equal(ORDER_DIAGNOSTICS[key].message(values), expected);
    assert.equal(ORDER_DIAGNOSTICS[key].category, category);
  });
}

test('claim and owner rules belong to their call/header places with frozen data and author guidance', () => {
  for (const [key, rules] of [['order-launch-exclusive', CALL_RULES], ['order-id-owner', HEADER_RULES]]) {
    const entry = ORDER_RULES[key];
    assert.equal(entry, rules[key]);
    assert.equal(entry.topic, 'order');
    assert.ok(entry.rule.trim());
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.data));
    assert.ok(!entry.message.toString().includes('The run folder was not created; quota was not spent.'));
  }
  assert.ok(!ORDER_RULES['order-launch-exclusive'].data.includes('holderDescription'));
});

test('claim, owner and diagnostic selectors reject absent or unknown values without a default', () => {
  for (const [builder, key, selector] of [
    [orderRuleMessage, 'order-launch-exclusive', 'variant'], [orderRuleMessage, 'order-id-owner', 'violation'],
    [orderDiagnosticMessage, 'order-claim-input-valid', 'violation'],
    [orderDiagnosticMessage, 'codex-availability-detail', 'variant'],
  ]) {
    for (const value of [undefined, 'unknown', 'toString', '__proto__']) {
      assert.throws(() => builder(key, { [selector]: value }), {
        message: `unknown ${key} ${selector}: ${value}`,
      });
    }
  }
});

for (const name of ['order-claim', 'order-owner', 'codex-availability', 'worker-admission']) {
  test(`${name} passes the static guard without pending migration or opt-outs`, () => {
    const file = `src/home/lib/runner/${name}.mjs`;
    assert.ok(ADMISSION_FILES.includes(file));
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.deepEqual(checkRefusalSites(source, file), { violations: [], optOuts: [] });
    assert.doesNotMatch(source, /recordOrderText|pending producer|order-guard: not-a-refusal/);
    assert.ok(!source.includes('The run folder was not created; quota was not spent.'));
  });
}

const suffix = ' The run folder was not created; quota was not spent.';
test('claim callers preserve both holder descriptions and every complete busy refusal', () => {
  assert.equal(orderClaimHolderText(null), claimMessages[0][1]);
  for (const [index, role] of [[1, 'launcher'], [2, 'worker']]) {
    const value = { ...holder, role };
    assert.equal(orderClaimHolderText(value), claimMessages[index][1]);
    assert.equal(orderClaimBusyText('Order-A', value), claimMessages[index + 3][1] + suffix);
  }
  assert.equal(orderClaimBusyText('Order-A', null), claimMessages[3][1] + suffix);
});

test('claim input failures preserve TypeError/Error classes and validation priority', async () => {
  const root = makeTempTree('order-rules-claims-errors-');
  for (const orderId of [undefined, null, '', 1, {}]) {
    assert.throws(() => orderClaimAddress(root, orderId), {
      name: 'TypeError', message: 'orderId must be a non-empty string',
    });
  }
  for (const role of [undefined, null, '', 'Launcher', 'other', 1]) {
    await assert.rejects(acquireOrderClaim({ projectRunsRoot: root, orderId: '', role }), {
      name: 'TypeError', message: 'role must be launcher or worker',
    });
  }
  const missing = path.join(root, 'missing');
  assert.throws(() => orderClaimAddress(missing, 'Order-A'), {
    name: 'Error', message: diagnosticMessages[2][3].replace('C:/missing/runs', missing),
  });
});

test('owner callers preserve both conflicts, missing schemes and JSON order-id formatting', () => {
  for (const scheme of [undefined, 1, 2]) {
    const owner = { status: {
      slug: ownerValues.slug, started_at: ownerValues.startedAt, task_hash_scheme: scheme,
    } };
    assert.equal(orderOwnerConflictText(owner, ownerValues.ownerDir, 'order-1'), ownerMessages[scheme === 2 ? 0 : 1][1]);
    for (const [orderId, quoted] of [[null, '""'], [42, '"42"'], ['a"b', '"a\\"b"']]) {
      assert.equal(orderOwnerConflictText(owner, ownerValues.ownerDir, orderId),
        ownerMessages[scheme === 2 ? 0 : 1][1].replace('"order-1"', quoted));
    }
  }
});

test('unclaimed race keeps its complete refusal and null successes without writing a run', () => {
  const root = makeTempTree('order-rules-claims-race-');
  const repo = path.join(root, 'repo');
  const input = { projectRunsRoot: root, repoRoot: repo, slug: 'new-run', taskHash: 'hash', orderId: 'Order-A', chainBefore: [] };
  assert.equal(unclaimedRaceRefusal(input), null);
  const run = '2026-10-04_120000_new-run';
  fs.mkdirSync(path.join(root, run));
  fs.writeFileSync(path.join(root, run, 'status.json'), JSON.stringify({
    repo, slug: 'new-run', order_id: 'Order-A', task_hash: 'hash', started_at: '2026-10-04T12:00:00.000Z',
  }) + '\n');
  assert.equal(unclaimedRaceRefusal(input), claimMessages[6][1] + suffix);
  assert.equal(unclaimedRaceRefusal({ ...input, chainBefore: [run] }), null);
  assert.equal(unclaimedRaceRefusal({ ...input, orderId: 'order-a' }), null);
  assert.deepEqual(fs.readdirSync(root), [run]);
});

test('availability catch without a system message preserves its fallback detail', async () => {
  for (const error of [null, undefined, {}, new Error(''), new Error(' \r\n ')]) {
    assert.deepEqual(await probeCodexAvailability({ resolve: () => { throw error; } }), {
      state: 'inconclusive', detail: 'codex availability probe failed',
    });
  }
});

// Plan_79 D6: deliberate laundering probes use a separate child-process marker directory.
test('issued holder text composes cleanly while handwritten or unknown parameters are journaled', () => {
  const root = path.join(makeTempTree('order-rules-claims-params-'), 'marker');
  const lib = new URL('../src/home/lib/', import.meta.url);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { orderRuleMessage } from ${JSON.stringify(new URL('order-rules.mjs', lib).href)};
    import { orderDiagnosticMessage } from ${JSON.stringify(new URL('order-diagnostics.mjs', lib).href)};
    import { checkOutgoingRefusal } from ${JSON.stringify(new URL('order-text-record.mjs', lib).href)};
    import { orderClaimBusyText } from ${JSON.stringify(new URL('runner/order-claim.mjs', lib).href)};
    for (const [key, cases] of ${JSON.stringify([['order-launch-exclusive', claimMessages], ['order-id-owner', ownerMessages]])}) {
      for (const [values, expected] of cases) {
        const text = orderRuleMessage(key, values);
        assert.equal(text, expected);
        checkOutgoingRefusal(text, 'claims-probe');
      }
    }
    for (const [key, values, , expected] of ${JSON.stringify(diagnosticMessages)}) {
      const text = orderDiagnosticMessage(key, values);
      assert.equal(text, expected);
      checkOutgoingRefusal(text, 'claims-probe');
    }
    for (const holder of [null, ${JSON.stringify(holder)}, { ...${JSON.stringify(holder)}, role: 'worker' }]) {
      checkOutgoingRefusal(orderClaimBusyText('Order-A', holder), 'claims-probe');
    }
    const text = orderRuleMessage('order-launch-exclusive', {
      variant: 'busy', orderId: 'Order-A', holderDescription: 'handwritten holder refusal',
    });
    checkOutgoingRefusal([text, orderDiagnosticMessage('run-not-created')].join(' '), 'claims-probe');
    orderDiagnosticMessage('codex-availability-detail', { variant: 'failed', unknown: 'handwritten parameter' });
  `], { env: { ...process.env, CODEX_BRIDGE_TEST_TMP: root }, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entries = fs.readdirSync(path.join(root, 'order-text-violations')).flatMap((file) =>
    fs.readFileSync(path.join(root, 'order-text-violations', file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(({ kind, builder, key, parameter }) => [kind, builder, key, parameter]), [
    ['parameter', 'orderRuleMessage', 'order-launch-exclusive', 'holderDescription'],
    ['parameter', 'orderDiagnosticMessage', 'codex-availability-detail', 'unknown'],
  ]);
  assert.deepEqual(entries.map(({ message }) => message), ['handwritten holder refusal', 'handwritten parameter']);
  for (const entry of entries) {
    assert.notEqual(entry.pid, process.pid);
    assert.match(entry.stack, /checkOrderTextParameters/);
    assert.ok(entry.caller);
  }
});
