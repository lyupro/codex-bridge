/** Guards the Plan_79 D3 registry contract before any refusal site is migrated. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUIDANCE_TOPICS } from '../cli/guidance-topics.mjs';
import {
  ORDER_RULES, orderRuleMessage, validateOrderRules,
} from '../src/home/lib/order-rules.mjs';
import {
  DIAGNOSTIC_CATEGORIES, ORDER_DIAGNOSTICS, orderDiagnosticMessage, validateOrderDiagnostics,
} from '../src/home/lib/order-diagnostics.mjs';

test('registry maps and entries are frozen and have exactly their contracted fields', () => {
  assert.ok(Object.isFrozen(ORDER_RULES));
  assert.ok(Object.isFrozen(ORDER_DIAGNOSTICS));
  assert.deepEqual(Object.keys(ORDER_RULES).sort(), [
    'effort-value', 'question-context-marker', 'repository-path', 'run-slug', 'scout-questions', 'verify-line',
    'task-body-required', 'task-file-path',
    'order-header-label-shape', 'unknown-header-label', 'duplicate-order-label', 'grant-label-exclusive',
    'advice-value-shape', 'grant-value-shape', 'header-metadata-placement',
    'agent-accepted-labels', 'order-value-placeholder', 'header-shell-safety',
    'build-existing-scope-required', 'required-order-labels',
    'scope-pattern-shape', 'scope-pattern-match',
    'continuation-grant-usable', 'retry-grant-usable', 'ready-grant-line', 'grant-last-run-hint',
    'advisor-scope-continuation', 'retry-pass-identity', 'repeat-task-grant-required',
    'advisor-advise-continuation', 'build-advice-required', 'advise-scope-run-required',
    'run-phase-required', 'writing-run-exclusive', 'order-launch-exclusive', 'order-id-owner',
    'advisor-task-options', 'advisor-task-paths', 'advice-retired-root',
    'scope-pattern-refusal',
    'agent-call-model', 'agent-call-teammate', 'dispatcher-call-shape', 'dispatcher-task-file-help',
    'dispatcher-call-refusal', 'dispatcher-call-summary',
  ].sort());
  for (const entry of Object.values(ORDER_RULES)) {
    assert.ok(Object.isFrozen(entry));
    assert.deepEqual(Object.keys(entry).sort(), ['data', 'message', 'rule', 'topic']);
    assert.equal(typeof entry.message, 'function');
  }
  for (const entry of Object.values(ORDER_DIAGNOSTICS)) {
    assert.ok(Object.isFrozen(entry));
    assert.deepEqual(Object.keys(entry).sort(), ['category', 'data', 'message']);
    assert.equal(typeof entry.message, 'function');
  }
  assert.deepEqual(Object.keys(ORDER_DIAGNOSTICS).sort(), [
    'no-wait-grant-conflict', 'task-channel-conflict', 'unexpected-argument', 'unknown-flag',
    'boolean-flag-value', 'missing-flag-value', 'flag-shell-safety', 'agent-required', 'agent-known',
    'task-file-readable',
    'project-runs-folder-required',
    'runs-move-record-readable',
    'codex-readiness-unconfirmed', 'codex-unavailable',
    'codex-availability-detail',
    'codex-unavailable-handoff', 'stale-runs-root-override', 'runs-move-record-invalid',
    'sandbox-probe-reason',
    'sandbox-refusal-repair',
    'sandbox-linux-repair',
    'sandbox-operator-check',
    'sandbox-stderr-evidence',
    'sandbox-diagnosis-source',
    'sandbox-diagnosis-attribution',
    'sandbox-setup-change',
    'sandbox-evidence-line',
    'sandbox-evidence-unknown',
    'sandbox-no-repair',
    'sandbox-known-failure-runtime-file-locked',
    'sandbox-known-failure-deny-read-state-corrupt',
    'run-not-created',
    'advise-scope-result-readable', 'advise-scope-result-shape',
    'dispatcher-agent-known', 'order-input-name-known',
    'advise-scope-input-required',
    'order-claim-input-valid',
    'advisor-task-text-required',
    'sandbox-probe-repository-required',
    'cmd-argument-transport', 'run-worker-start-failure', 'repository-detached-after-abandoned-run', 'codex-not-started',
    'subagent-model-env-pin', 'dispatcher-agent-input-known', 'dispatcher-prompt-text-required', 'dispatcher-refusal',
  ].sort());
  assert.equal(ORDER_DIAGNOSTICS['no-wait-grant-conflict'].category, 'cli-flags');
});

test('keys are kebab-case and unique across the two registries', () => {
  const keys = [...Object.keys(ORDER_RULES), ...Object.keys(ORDER_DIAGNOSTICS)];
  for (const key of keys) assert.match(key, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
  assert.equal(new Set(keys).size, keys.length);
});

test('rule topics exist in GUIDANCE_TOPICS and rule text is non-empty without placeholders', () => {
  for (const entry of Object.values(ORDER_RULES)) {
    assert.ok(Object.hasOwn(GUIDANCE_TOPICS, entry.topic));
    assert.equal(typeof entry.rule, 'string');
    assert.ok(entry.rule.trim());
    assert.ok(!entry.rule.includes('{{'));
  }
  assert.doesNotThrow(() => validateOrderRules(ORDER_RULES, GUIDANCE_TOPICS, ORDER_DIAGNOSTICS));
});

test('diagnostic categories are closed and frozen', () => {
  assert.ok(Object.isFrozen(DIAGNOSTIC_CATEGORIES));
  assert.deepEqual(DIAGNOSTIC_CATEGORIES, [
    'cli-flags', 'filesystem', 'host-state', 'run-state', 'internal',
  ]);
  for (const entry of Object.values(ORDER_DIAGNOSTICS)) {
    assert.ok(DIAGNOSTIC_CATEGORIES.includes(entry.category));
  }
  assert.doesNotThrow(() => validateOrderDiagnostics(ORDER_DIAGNOSTICS));
  for (const category of DIAGNOSTIC_CATEGORIES) {
    assert.doesNotThrow(() => validateOrderDiagnostics({
      'sample-diagnostic': { category, message: () => 'sample', data: [] },
    }));
  }
});

for (const key of ['missing-rule', 'toString', 'constructor', '__proto__']) {
  test(`unknown key ${key} throws a programming error in both helpers`, () => {
    assert.throws(() => orderRuleMessage(key), {
      name: 'Error', message: `unknown order rule: ${key}`,
    });
    assert.throws(() => orderDiagnosticMessage(key), {
      name: 'Error', message: `unknown order diagnostic: ${key}`,
    });
  });
}

const sampleRule = { topic: 'order', rule: 'Write an order.', message: () => 'sample', data: [] };
const invalidRules = [
  ['unknown topic', { ...sampleRule, topic: 'unknown' }, 'unknown order rule topic: sample-rule'],
  ['inherited topic', { ...sampleRule, topic: 'toString' }, 'unknown order rule topic: sample-rule'],
  ['empty rule', { ...sampleRule, rule: '' }, 'invalid order rule text: sample-rule'],
  ['blank rule', { ...sampleRule, rule: ' \t\n' }, 'invalid order rule text: sample-rule'],
  ['non-string rule', { ...sampleRule, rule: 1 }, 'invalid order rule text: sample-rule'],
  ['placeholder', { ...sampleRule, rule: 'Use {{root}}.' }, 'invalid order rule text: sample-rule'],
  ['extra field', { ...sampleRule, extra: true }, 'invalid order rule entry: sample-rule'],
  ['missing field', { topic: 'order', message: () => 'sample', data: [] }, 'invalid order rule entry: sample-rule'],
  ['non-function message', { ...sampleRule, message: 'sample' }, 'invalid order rule message: sample-rule'],
];
for (const [label, entry, message] of invalidRules) {
  test(`rule validator rejects ${label}`, () => {
    assert.throws(() => validateOrderRules({ 'sample-rule': entry }, GUIDANCE_TOPICS, {}), { message });
  });
}

test('rule validator rejects a duplicate key across modules', () => {
  assert.throws(() => validateOrderRules(
    { 'sample-rule': sampleRule }, GUIDANCE_TOPICS,
    { 'sample-rule': { category: 'internal', message: () => 'sample', data: [] } },
  ), { message: 'duplicate order key: sample-rule' });
});

for (const key of ['Bad-key', 'bad_key', 'bad--key', '-bad', 'bad-', '1-bad']) {
  test(`both validators reject non-kebab key ${key}`, () => {
    assert.throws(() => validateOrderRules({ [key]: sampleRule }, GUIDANCE_TOPICS, {}), {
      message: `invalid order rule key: ${key}`,
    });
    assert.throws(() => validateOrderDiagnostics({
      [key]: { category: 'internal', message: () => 'sample', data: [] },
    }), { message: `invalid order diagnostic key: ${key}` });
  });
}

const invalidDiagnostics = [
  ['unknown category', { category: 'unknown', message: () => 'sample', data: [] },
    'unknown order diagnostic category: sample-diagnostic'],
  ['extra field', { category: 'internal', message: () => 'sample', data: [], extra: true },
    'invalid order diagnostic entry: sample-diagnostic'],
  ['missing field', { message: () => 'sample', data: [] }, 'invalid order diagnostic entry: sample-diagnostic'],
  ['non-function message', { category: 'internal', message: 'sample', data: [] },
    'invalid order diagnostic message: sample-diagnostic'],
];
for (const [label, entry, message] of invalidDiagnostics) {
  test(`diagnostic validator rejects ${label}`, () => {
    assert.throws(() => validateOrderDiagnostics({ 'sample-diagnostic': entry }), { message });
  });
}
