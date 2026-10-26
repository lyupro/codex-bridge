/** OW-075 A3c: the completed migration must never regain an implicit next action. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lex } from '../order-guard/lexer.mjs';
import { die } from '../../src/home/lib/runner/args.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';

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

function dieCalls(source) {
  const { tokens } = lex(source);
  const calls = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].literal || tokens[i].value !== 'die' || tokens[i + 1]?.value !== '(' ||
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
    assert.equal(depth, 0, 'unterminated die call');
    calls.push({ offset: tokens[i].start, args: splitArguments(tokens.slice(i + 2, end)) });
  }
  return calls;
}

function assertAction(args) {
  assert.equal(args.length, 2, 'die needs a message and an action object');
  const options = args[1];
  assert.equal(options[0]?.value, '{', 'second argument must be an object');
  assert.equal(options.at(-1)?.value, '}');
  const actions = splitArguments(options.slice(1, -1)).filter((property) =>
    property[0]?.value === 'action' && property[1]?.value === ':');
  assert.equal(actions.length, 1, 'object must have one action: key');
  const value = actions[0].slice(2);
  if (value.map((token) => token.value).join('') === 'availability.action') {
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

test('die rejects missing, numeric and actionless options before printing', (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  const message = orderDiagnosticMessage('next-action-variant-required');
  for (const call of [() => die('x'), () => die('x', 1), () => die('x', {})]) {
    assert.throws(call, { name: 'Error', message });
  }
  assert.equal(printed.mock.callCount(), 0);
});
