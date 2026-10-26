/** OW-075 A3c / OW-077: the completed migration must never regain an implicit next action. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lex } from '../order-guard/lexer.mjs';
import { die } from '../../src/home/lib/runner/args.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import { writeFailure } from '../../src/home/lib/meta/run-state.mjs';
import { makeTempTree } from '../temp-tree.mjs';

// Split only at the current level: message builders can contain their own calls and objects.
function splitArguments(tokens) {
  const parts = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.literal) {
      // The shared lexer exposes template expressions too; their commas belong to the template.
      while (tokens[i + 1]?.start < token.end) i += 1;
      continue;
    }
    if ('([{'.includes(token.value)) stack.push(token.value);
    else if (')]}'.includes(token.value)) {
      assert.equal(stack.pop(), { ')': '(', ']': '[', '}': '{' }[token.value]);
    } else if (token.value === ',' && stack.length === 0) {
      parts.push(tokens.slice(start, i));
      start = i + 1;
    }
  }
  assert.equal(stack.length, 0, 'unbalanced argument list');
  if (start < tokens.length) parts.push(tokens.slice(start));
  return parts;
}

function dieCalls(source, name = 'die') {
  const { tokens } = lex(source);
  const calls = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].literal || tokens[i].value !== name || tokens[i + 1]?.value !== '(' ||
        tokens[i - 1]?.value === 'function') continue;
    let depth = 1;
    let end = i + 2;
    for (; end < tokens.length; end += 1) {
      const token = tokens[end];
      if (token.literal) {
        while (tokens[end + 1]?.start < token.end) end += 1;
        continue;
      }
      if (token.value === '(') depth += 1;
      if (token.value === ')' && --depth === 0) break;
    }
    assert.equal(depth, 0, `unterminated ${name} call`);
    calls.push({ offset: tokens[i].start, args: splitArguments(tokens.slice(i + 2, end)) });
  }
  return calls;
}

function assertAction(args, name = 'die') {
  const index = name === 'die' || name === 'deny' ? 1 : 3;
  assert.equal(args.length, index + 1, `${name} needs an action object`);
  const options = args[index];
  assert.equal(options[0]?.value, '{', 'options argument must be an object');
  assert.equal(options.at(-1)?.value, '}');
  const actions = splitArguments(options.slice(1, -1)).filter((property) =>
    property[0]?.value === 'action' && property[1]?.value === ':');
  assert.equal(actions.length, 1, 'object must have one action: key');
  const value = actions[0].slice(2);
  if (name === 'die' && value.map((token) => token.value).join('') === 'availability.action') {
    assert.equal(value.length, 3);
    return;
  }
  assert.equal(value.length, 1, 'action must be a string literal or availability.action');
  assert.ok(value[0].literal && /^(['"])[a-z][a-z-]*\1$/.test(value[0].value),
    'action must name a literal next-action variant');
  assert.doesNotThrow(() => orderDiagnosticMessage('next-action', { variant: value[0].value.slice(1, -1) }));
}

test('every die call under src/home/lib passes an explicit known action', (t) => {
  const root = fileURLToPath(new URL('../../src/home/lib/', import.meta.url));
  const files = fs.readdirSync(root, { recursive: true }).filter((file) => file.endsWith('.mjs'));
  let count = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const { args, offset } of dieCalls(source)) {
      count += 1;
      assert.doesNotThrow(() => assertAction(args), `${file}:${source.slice(0, offset).split('\n').length}`);
    }
  }
  assert.ok(count >= 37, `scanner found only ${count} die calls`);
  t.diagnostic(`validated ${count} die calls in ${files.length} modules`);
});

test('scanner skips definitions, comments and strings and balances complete call arguments', () => {
  const source = [
    'function die(message, options) {}',
    '// die("comment");',
    '/* die("block comment"); */',
    'const text = "die(\\"string\\")";',
    "const template = `die('template')`;",
    "die(build(nested('),'), { items: [one(), two()] }), { action: 'usage' });",
    "die(`text ${nested(')', 2)}`, { action: availability.action, exit: 1 });",
  ].join('\n');
  const calls = dieCalls(source);
  assert.equal(calls.length, 2);
  for (const { args } of calls) assertAction(args);
});

test('scanner rejects missing, numeric, nested, unknown and computed actions', () => {
  for (const source of [
    "die('x');", "die('x', 1);", "die('x', {});",
    "die('x', { nested: { action: 'usage' } });",
    "die('x', { action: 'unknown' });", "die('x', { action: chosen });",
    "die('x', { action: 'usage' + suffix });",
  ]) {
    const calls = dieCalls(source);
    assert.equal(calls.length, 1);
    assert.throws(() => assertAction(calls[0].args), { name: 'AssertionError' });
  }
});

test('every deny call in order-gate passes an explicit known literal action', (t) => {
  const file = 'src/home/hooks/order-gate.mjs';
  const source = fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
  const calls = dieCalls(source, 'deny');
  const definitionStart = source.indexOf('const deny =');
  const definitionEnd = source.indexOf('let input;', definitionStart);
  assert.ok(definitionStart >= 0 && definitionEnd > definitionStart, 'deny definition boundaries must exist');
  for (const { args, offset } of calls) {
    const location = file + ':' + source.slice(0, offset).split('\n').length;
    assert.ok(offset < definitionStart || offset >= definitionEnd, location + ': definition counted as a call');
    assert.doesNotThrow(() => assertAction(args, 'deny'), location);
  }
  assert.ok(calls.length >= 11, 'scanner found only ' + calls.length + ' deny calls');
  t.diagnostic('validated ' + calls.length + ' deny calls in ' + file);
});

test('order-gate emits deny decisions and reasons only inside the deny definition', () => {
  const source = fs.readFileSync(new URL('../../src/home/hooks/order-gate.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const deny =');
  const end = source.indexOf('let input;', start);
  assert.ok(start >= 0 && end > start, 'deny definition boundaries must exist');
  const decisions = [...source.matchAll(/permissionDecision\s*:\s*(['"])deny\1/g)];
  assert.equal(decisions.length, 1, 'deny must have exactly one decision emitter');
  assert.ok(decisions[0].index >= start && decisions[0].index < end, 'deny decision must be inside deny');
  assert.doesNotMatch(source.slice(0, start) + source.slice(end), /permissionDecisionReason/,
    'deny reasons must be emitted only inside deny');
});

test('deny scanner rejects missing, computed, unknown and actionless options', () => {
  for (const source of [
    'deny(x);', 'deny(x, { action: variable });',
    "deny(x, { action: 'bogus' });", 'deny(x, {});',
    'deny(x, { action: availability.action });',
  ]) {
    const calls = dieCalls(source, 'deny');
    assert.equal(calls.length, 1);
    assert.throws(() => assertAction(calls[0].args, 'deny'), { name: 'AssertionError' });
  }
  const calls = dieCalls("const deny = (reason, how) => {};\ndeny(x, { action: 'usage' });", 'deny');
  assert.equal(calls.length, 1, 'the const deny definition must not be counted as a call');
  assert.doesNotThrow(() => assertAction(calls[0].args, 'deny'));
});

test('die rejects missing, numeric and actionless options before printing', (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  const message = orderDiagnosticMessage('next-action-variant-required');
  for (const call of [() => die('x'), () => die('x', 1), () => die('x', {})]) {
    assert.throws(call, { name: 'Error', message });
  }
  assert.equal(printed.mock.callCount(), 0);
});

test('every writeFailure call under src/home/lib passes an explicit known literal action', (t) => {
  const root = fileURLToPath(new URL('../../src/home/lib/', import.meta.url));
  const files = fs.readdirSync(root, { recursive: true }).filter((file) => file.endsWith('.mjs'));
  let count = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const { args, offset } of dieCalls(source, 'writeFailure')) {
      count += 1;
      assert.doesNotThrow(() => assertAction(args, 'writeFailure'),
        file + ':' + source.slice(0, offset).split('\n').length);
    }
  }
  assert.ok(count >= 6, 'scanner found only ' + count + ' writeFailure calls');
  t.diagnostic('validated ' + count + ' writeFailure calls in ' + files.length + ' modules');
});

test('writeFailure scanner rejects positional, missing, nested, unknown and computed actions', () => {
  for (const options of ['', ', []', ', [], true', ', {}', ", { nested: { action: 'usage' } }",
    ", { action: 'unknown' }", ', { action: chosen }', ', { action: availability.action }',
    ", { action: 'usage' + suffix }"]) {
    const calls = dieCalls('writeFailure(dir, agent, reason' + options + ');', 'writeFailure');
    assert.equal(calls.length, 1);
    assert.throws(() => assertAction(calls[0].args, 'writeFailure'), { name: 'AssertionError' });
  }
});

test('writeFailure rejects absent action options before writing artifacts', () => {
  const dir = makeTempTree('failure-action-required-');
  const message = orderDiagnosticMessage('next-action-variant-required');
  for (const options of [undefined, null, 1, [], {}, { action: undefined }]) {
    assert.throws(() => writeFailure(dir, 'codex-build', 'fixture failure', options), { name: 'Error', message });
    assert.deepEqual(fs.readdirSync(dir), []);
  }
  assert.throws(() => writeFailure(dir, 'codex-build', 'fixture failure'), { name: 'Error', message });
});
