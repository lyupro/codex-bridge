/** D2: one resolver owns legacy numbers, phase maps and partial phase overrides. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AGENTS } from '../src/home/lib/agents.mjs';
import { resolveBudgets } from '../src/home/lib/budgets.mjs';
import { validateRunConfig } from '../src/home/lib/config-validate.mjs';

const FILE = 'operator/config.json';
const registry = {
  'test-single': { role: 'single', budget: 12 },
  'test-phased': { role: 'phased', budget: { scope: 5, advise: 15 } },
};

test('budget consumers never branch on the legacy numeric representation', () => {
  for (const file of ['agents.mjs', 'config-validate.mjs', 'run-config.mjs', 'meta/deadline.mjs',
    'runner/codex-args.mjs', 'runner/codex-cmd.mjs', 'runner/launcher.mjs',
    'runner/preflight.mjs', 'runner/worker-order.mjs', 'runner/worker.mjs']) {
    const source = fs.readFileSync(new URL(`../src/home/lib/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /typeof\s+\w*budget\w*\s*[!=]==?\s*['"]number['"]/i, file);
  }
});

test('numbers normalize to default and phase maps retain their declared minutes', () => {
  const resolved = resolveBudgets(FILE, {}, registry);
  assert.deepEqual(resolved, { single: { default: 12 }, phased: { scope: 5, advise: 15 } });
  resolved.phased.scope = 99;
  assert.deepEqual(registry['test-phased'].budget, { scope: 5, advise: 15 });
});

test('partial phase overrides retain the other phases and roles', () => {
  assert.deepEqual(resolveBudgets(FILE, { phased: { scope: 2.5 } }, registry), {
    single: { default: 12 }, phased: { scope: 2.5, advise: 15 },
  });
  assert.deepEqual(resolveBudgets(FILE, { phased: {}, single: { default: 3 } }, registry), {
    single: { default: 3 }, phased: { scope: 5, advise: 15 },
  });
});

test('a scalar config budget for a phased role fails loud instead of erasing its phases', () => {
  // Accepting it would turn {scope, advise} into {default}: the config reads cleanly and
  // every later run of that role is refused with "allowed phases: default".
  assert.throws(() => resolveBudgets(FILE, { phased: 9 }, registry),
    /budgets\.phased.*must be a phase map.*"scope": 5, "advise": 15.*not 9/);
  assert.deepEqual(resolveBudgets(FILE, { single: 9 }, registry).single, { default: 9 });
  assert.throws(() => resolveBudgets(FILE, { phased: { default: 9 } }, registry),
    /budgets.phased.*unknown phase.*default.*scope, advise/);
});

test('config accepts legacy numbers and explicit default maps for every registered role', () => {
  for (const { role } of Object.values(AGENTS)) {
    assert.deepEqual(validateRunConfig(FILE, { budgets: { [role]: 7.5 } }).budgets[role], { default: 7.5 });
    assert.deepEqual(validateRunConfig(FILE, { budgets: { [role]: { default: 8 } } }).budgets[role], { default: 8 });
  }
});

test('config merges a test-only multi-phase registry without adding an agent', (t) => {
  const original = AGENTS['codex-scout'].budget;
  t.after(() => { AGENTS['codex-scout'].budget = original; });
  AGENTS['codex-scout'].budget = { scope: 5, advise: 15 };
  assert.deepEqual(validateRunConfig(FILE, { budgets: { scout: { advise: 12 } } }).budgets.scout,
    { scope: 5, advise: 12 });
  assert.throws(() => validateRunConfig(FILE, { budgets: { scout: 9 } }),
    /budgets\.scout.*must be a phase map/);
  assert.throws(() => validateRunConfig(FILE, { budgets: { scout: { typo: 5 } } }),
    /operator\/config.json.*budgets.scout.*unknown phase.*typo.*scope, advise/);
});

test('an object cannot invent phases for a numeric registry budget', () => {
  assert.throws(() => validateRunConfig(FILE, { budgets: { build: { scope: 5 } } }),
    /operator\/config.json.*budgets.build.*unknown phase.*scope.*default/);
  for (const phase of ['constructor', 'toString', '__proto__']) {
    assert.throws(() => resolveBudgets(FILE, { phased: { [phase]: 5 } }, registry), /unknown phase/);
  }
});

test('each phase value must be a finite positive number with its exact config key in the error', () => {
  for (const value of [0, -1, NaN, Infinity, -Infinity, '5', '', ' ', null, true, [], {}]) {
    assert.throws(() => resolveBudgets(FILE, { phased: { scope: value } }, registry),
      /operator\/config.json.*budgets.phased.scope.*positive number of minutes/);
    assert.throws(() => validateRunConfig(FILE, { budgets: { build: { default: value } } }),
      /operator\/config.json.*budgets.build.default.*positive number of minutes/);
  }
});

test('invalid budget forms, unknown roles and malformed registry budgets fail loud', () => {
  for (const value of [0, -1, NaN, Infinity, -Infinity, '5', null, true, [], false]) {
    assert.throws(() => resolveBudgets(FILE, { single: value }, registry), /budgets.single.*positive number/);
  }
  for (const value of ['', ' ']) {
    assert.throws(() => resolveBudgets(FILE, { single: value }, registry), /budgets.single.*empty.*remove/);
  }
  for (const value of [null, [], 5, '5']) {
    assert.throws(() => resolveBudgets(FILE, value, registry), /budgets.*must be an object/);
  }
  assert.throws(() => resolveBudgets(FILE, { unknown: 5 }, registry), /unknown role.*single, phased/);
  assert.throws(() => resolveBudgets(FILE, { phased: { '': 5 } }, registry), /empty phase name/);
  for (const budget of [{}, { scope: 0 }, { scope: '5' }, 0]) {
    assert.throws(() => resolveBudgets(FILE, {}, { fixture: { role: 'fixture', budget } }),
      /budgets.fixture.*(?:declare at least one phase|positive number)/);
  }
});
