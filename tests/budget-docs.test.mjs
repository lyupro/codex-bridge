/**
 * Plan_80 E38/E39: two copies drift when public prose repeats registry budgets.
 * Keep one complete package-defaults example checked directly against the registry;
 * resolving it would silently fill missing roles or phases and hide an incomplete example.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AGENTS } from '../src/home/lib/agents.mjs';
import { renderDispatcherProtocol } from '../src/home/lib/dispatcher-protocol.mjs';

const root = new URL('../', import.meta.url);
const begin = '<!-- budget-defaults:begin -->';
const end = '<!-- budget-defaults:end -->';
const overview = fs.readFileSync(new URL('docs/overview.md', root), 'utf8');
const declaredBudgets = Object.fromEntries(Object.values(AGENTS).map(({ role, budget }) => [role, budget]));
const names = [...new Set(Object.values(AGENTS).flatMap(({ role, budget }) =>
  [role, ...(typeof budget === 'number' ? [] : Object.keys(budget))]))];
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namedRoleOrPhase = new RegExp(`\\b(?:${names.map(escapeRegex).join('|')})\\b`, 'i');
const roleNumber = new RegExp('\\b(?:' + names.map(escapeRegex).join('|') + ')\\b`?\\s*[:=]?\\s*\\d+(?:\\.\\d+)?\\b', 'gi');

function defaultsExample(text) {
  assert.equal(text.split(begin).length - 1, 1, 'expected exactly one budget-defaults begin marker');
  assert.equal(text.split(end).length - 1, 1, 'expected exactly one budget-defaults end marker');
  const block = /^<!-- budget-defaults:begin -->\r?\n([\s\S]*?)\r?\n<!-- budget-defaults:end -->$/m.exec(text);
  assert.ok(block, 'budget-defaults markers must be ordered and on their own lines');
  const json = /^```json\r?\n([\s\S]*?)\r?\n```$/.exec(block[1]);
  assert.ok(json, 'budget-defaults block must contain exactly one JSON example');
  return JSON.parse(json[1]);
}

function compareBudgets(example) {
  assert.deepEqual(example.budgets, declaredBudgets,
    'package-defaults example must match every registry role, phase, value and shape');
}

function budgetDeclarations(text) {
  return text.split(/\r?\n\s*\r?\n|(?<=[.!?])\s+|(?=^\s*[-*] )/m)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => {
      if (/\b(?:about|took|ran up to)\b|\b20\d{2}-\d{2}-\d{2}\b/i.test(sentence)) return false;
      // Dispatcher attach ceilings and observed runtime estimates are not agent allocations.
      if (/\b(?:attaching call|wait ceiling|runtime estimate|real run takes)\b/i.test(sentence)) return false;
      const minutes = /\b\d+(?:\.\d+)?(?:-minute\b|\s+(?:minutes?|min)\b)/i.test(sentence);
      const deadline = /\b(?:budgets?|deadlines?|limits?|phases?)\b/i.test(sentence);
      // The old compact role/number list declared budgets without units or a deadline word.
      const shorthand = [...sentence.matchAll(roleNumber)].length > 1;
      return shorthand || (minutes && deadline && namedRoleOrPhase.test(sentence));
    });
}

test('the single marked package-defaults JSON example matches the registry directly', () => {
  compareBudgets(defaultsExample(overview));
});

test('altered values, missing roles or phases and normalized scalar maps cannot pass', () => {
  const original = defaultsExample(overview);
  const changed = structuredClone(original);
  changed.budgets.advisor.advise += 1;
  assert.throws(() => compareBudgets(changed), /package-defaults example/);

  const missingPhase = structuredClone(original);
  delete missingPhase.budgets.advisor.scope;
  assert.throws(() => compareBudgets(missingPhase), /package-defaults example/);

  const missingRole = structuredClone(original);
  delete missingRole.budgets.scout;
  assert.throws(() => compareBudgets(missingRole), /package-defaults example/);

  const normalized = structuredClone(original);
  normalized.budgets.build = { default: normalized.budgets.build };
  assert.throws(() => compareBudgets(normalized), /package-defaults example/);
});

test('missing, duplicate, misplaced markers and invalid JSON cannot pass', () => {
  for (const text of [
    overview.replace(begin, ''),
    overview.replace(end, ''),
    `${overview}\n${begin}\n`,
    `${overview}\n${end}\n`,
    overview.replace(begin, `inline ${begin}`),
    overview.replace(end, `inline ${end}`),
    `${end}\n${begin}`,
    [begin, '```json', '{ invalid }', '```', end].join('\n'),
  ]) assert.throws(() => defaultsExample(text));
});

test('public prose refers to effective budgets instead of declaring copied numbers', () => {
  const guidance = new URL('src/home/guidance/', root);
  const files = [new URL('README.md', root), new URL('docs/overview.md', root),
    ...fs.readdirSync(guidance).filter((name) => name.endsWith('.md')).map((name) => new URL(name, guidance))];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const prose = file.href === new URL('docs/overview.md', root).href
      ? text.replace(/<!-- budget-defaults:begin -->[\s\S]*?<!-- budget-defaults:end -->/, '')
      : text;
    assert.deepEqual(budgetDeclarations(prose), [], `${file.pathname} repeats a budget declaration`);
  }
});

for (const text of [
  'A build run has a 25-minute deadline.',
  'The 35-minute `advise` phase is available',
  '`scout` 15, `build` 25',
  'The `advisor` advise budget is 35 minutes.',
  'The `review` limit is 20 min.',
  'The scout deadline is\n15 minutes.',
  'Past runs took about twenty minutes. The build deadline is 25 minutes.',
  'The build artifact is in config.json; its deadline is 25 minutes.',
]) {
  test(`prose guard rejects: ${text}`, () => {
    assert.ok(budgetDeclarations(text).length > 0, text);
  });
}

for (const text of [
  'took about twenty minutes',
  'healthy advise passes ran up to about 25 minutes (Plan_80 E32)',
  'check `codex --version` for up to ~2 minutes',
  'The 2026-08-09 build run consumed 18 minutes of quota before its scope limit was checked.',
  'A build run took 25 minutes before its deadline.',
  'The build deadline is shown by `codex-bridge guidance budget`.',
]) {
  test(`prose guard permits: ${text}`, () => {
    assert.deepEqual(budgetDeclarations(text), []);
  });
}

test('the exported dispatcher wait ceiling and runtime estimate are not budget declarations', () => {
  const protocol = renderDispatcherProtocol('codex-build');
  const ceiling = /Give the attaching call[^.]+\./.exec(protocol)?.[0];
  const runtime = /A real run takes[\s\S]*?\./.exec(protocol)?.[0];
  assert.ok(ceiling, 'exported dispatcher protocol must supply its wait-ceiling sentence');
  assert.ok(runtime, 'exported dispatcher protocol must supply its runtime estimate');
  assert.deepEqual(budgetDeclarations(ceiling), []);
  assert.deepEqual(budgetDeclarations(runtime), []);
});
