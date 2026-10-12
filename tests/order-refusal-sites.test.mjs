/**
 * Plan_79 B2d / D3: admission refusals must not acquire text outside the registries.
 * This is a text guard, not a JavaScript parser or identifier/data-flow resolver:
 * - Strip line/block comments lexically, retaining original offsets and physical lines.
 *   Quoted strings, regexes and template text are opaque; template expressions are scanned.
 *   Regexes start at expression-start tokens or after control-statement parentheses.
 * - Check the first argument of die/deny/new Error/new RunnerUsageError/problems.push,
 *   object properties reason/refusal, and return values. Whitespace, comments and grouping
 *   parentheses may intervene. A newline after return ends that return (JavaScript ASI).
 * - A value beginning with a quoted string or ANY template is a violation, including a
 *   template wrapping a registry builder. Identifiers and orderRuleMessage/orderDiagnosticMessage
 *   calls are allowed; builder key/parameter literals are not themselves refusal messages.
 * - Only a trailing line comment on the literal's opening line can exempt it:
 *   // order-guard: not-a-refusal — <reason of at least three words>
 *   Every accepted exemption is printed for review. Missing/short reasons exempt nothing.
 * Pending admission files are visibly skipped until their Plan_79 migration slice lands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ADMISSION_FILES = [
  'src/home/lib/runner/args.mjs',
  'src/home/lib/runner/task-input.mjs',
  'src/home/lib/runner/task-file.mjs',
  'src/home/lib/runner/question-kind.mjs',
  'src/home/lib/runner/order-options.mjs',
  'src/home/lib/order-schema.mjs',
  'src/home/lib/order-values.mjs',
  'src/home/lib/task-header.mjs',
  'src/home/lib/runner/launcher.mjs',
  'src/home/lib/runner/scope-check.mjs',
  'src/home/lib/runner/pass-gate.mjs',
  'src/home/lib/runner/continuation.mjs',
  'src/home/lib/runner/advise-carry.mjs',
  'src/home/lib/runner/preflight.mjs',
  'src/home/lib/runner/order-claim.mjs',
  'src/home/lib/runner/order-owner.mjs',
  'src/home/lib/runner/codex-availability.mjs',
  'src/home/lib/runner/worker-admission.mjs',
  'src/home/hooks/order-gate.mjs',
  'src/home/lib/dispatcher-call.mjs',
  'src/home/lib/dispatcher-command.mjs',
  'src/home/lib/dispatcher-gate.mjs',
  'src/home/lib/dispatcher-order.mjs',
  'src/home/lib/dispatcher-state.mjs',
  'src/home/lib/dispatcher-pin.mjs',
  'src/home/lib/dispatcher-model.mjs',
];

// Later Plan_79 slices move these files onto the registry and remove their entries; delete this list when empty.
const PENDING_MIGRATION = new Set([
  'src/home/lib/runner/args.mjs',
  'src/home/lib/runner/task-input.mjs',
  'src/home/lib/runner/order-options.mjs',
  'src/home/lib/order-schema.mjs',
  'src/home/lib/order-values.mjs',
  'src/home/lib/task-header.mjs',
  'src/home/lib/runner/launcher.mjs',
  'src/home/lib/runner/scope-check.mjs',
  'src/home/lib/runner/pass-gate.mjs',
  'src/home/lib/runner/continuation.mjs',
  'src/home/lib/runner/advise-carry.mjs',
  'src/home/lib/runner/preflight.mjs',
  'src/home/lib/runner/order-claim.mjs',
  'src/home/lib/runner/order-owner.mjs',
  'src/home/lib/runner/codex-availability.mjs',
  'src/home/lib/runner/worker-admission.mjs',
  'src/home/hooks/order-gate.mjs',
  'src/home/lib/dispatcher-call.mjs',
  'src/home/lib/dispatcher-command.mjs',
  'src/home/lib/dispatcher-gate.mjs',
  'src/home/lib/dispatcher-order.mjs',
  'src/home/lib/dispatcher-state.mjs',
  'src/home/lib/dispatcher-pin.mjs',
  'src/home/lib/dispatcher-model.mjs',
]);

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const lineAt = (source, offset) => source.slice(0, offset).split(/\r\n|\r|\n/).length;

function lex(source) {
  const tokens = [];
  const optOuts = new Map();
  const add = (start, end, literal = false) => {
    const token = { value: source.slice(start, end), start, end, literal };
    tokens.push(token);
    return token;
  };
  const quotedEnd = (start) => {
    let cursor = start + 1;
    while (cursor < source.length) {
      if (source[cursor] === '\\') cursor += 2;
      else if (source[cursor++] === source[start]) break;
    }
    return cursor;
  };
  const regexEnd = (start) => {
    let inClass = false;
    for (let cursor = start + 1; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (char === '\r' || char === '\n') return start + 1;
      if (char === '\\') cursor += 1;
      else if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) {
        cursor += 1;
        while (/[a-z]/i.test(source[cursor] ?? '')) cursor += 1;
        return cursor;
      }
    }
    return start + 1;
  };
  const scan = (start, interpolation = false) => {
    let cursor = start;
    let braces = 0;
    let regexAllowed = true;
    let previousWord = '';
    const controlParens = [];
    while (cursor < source.length) {
      const char = source[cursor];
      const next = source[cursor + 1];
      if (/\s/.test(char)) { cursor += 1; continue; }
      if (char === '/' && (next === '/' || next === '*')) {
        const commentStart = cursor;
        if (next === '/') {
          while (cursor < source.length && !/[\r\n]/.test(source[cursor])) cursor += 1;
          const comment = source.slice(commentStart, cursor);
          const marker = /^\/\/\s*order-guard: not-a-refusal —\s*(.*?)\s*$/.exec(comment);
          const lineStart = Math.max(source.lastIndexOf('\n', commentStart - 1), source.lastIndexOf('\r', commentStart - 1)) + 1;
          const words = marker?.[1].match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
          if (words.length >= 3 && /\S/.test(source.slice(lineStart, commentStart))) {
            optOuts.set(lineAt(source, commentStart), comment);
          }
        } else {
          const end = source.indexOf('*/', cursor + 2);
          cursor = end < 0 ? source.length : end + 2;
        }
        continue;
      }
      if (char === '"' || char === "'") {
        const end = quotedEnd(cursor);
        add(cursor, end, true);
        cursor = end;
        regexAllowed = false;
        previousWord = '';
        continue;
      }
      if (char === '`') {
        const token = add(cursor, cursor + 1, true);
        cursor += 1;
        while (cursor < source.length) {
          if (source[cursor] === '\\') cursor += 2;
          else if (source[cursor] === '`') { cursor += 1; break; }
          else if (source[cursor] === '$' && source[cursor + 1] === '{') cursor = scan(cursor + 2, true);
          else cursor += 1;
        }
        token.end = cursor;
        regexAllowed = false;
        previousWord = '';
        continue;
      }
      if (char === '/' && regexAllowed) {
        const end = regexEnd(cursor);
        if (end > cursor + 1) {
          add(cursor, end);
          cursor = end;
          regexAllowed = false;
          previousWord = '';
          continue;
        }
      }
      if (/[\w$]/.test(char)) {
        const wordStart = cursor++;
        while (/[\w$]/.test(source[cursor] ?? '')) cursor += 1;
        previousWord = add(wordStart, cursor).value;
        regexAllowed = /^(?:return|throw|case|typeof|void|delete|new|in|of|yield|await|else|do)$/.test(previousWord);
        continue;
      }
      if (char === '}' && interpolation && braces === 0) return cursor + 1;
      if (char === '{') braces += 1;
      if (char === '}') braces -= 1;
      if (char === '(') {
        controlParens.push(/^(?:if|while|for|with|switch|catch)$/.test(previousWord));
        regexAllowed = true;
      } else if (char === ')') regexAllowed = controlParens.pop() === true;
      else regexAllowed = '([{,=:!&|?};+-*%<>~^'.includes(char);
      add(cursor, cursor + 1);
      cursor += 1;
      previousWord = '';
    }
    return cursor;
  };
  scan(0);
  return { tokens, optOuts };
}

function checkRefusalSites(source, file) {
  const { tokens, optOuts } = lex(source);
  const violations = [];
  const at = (index) => tokens[index]?.value;
  for (let index = 0; index < tokens.length; index += 1) {
    const word = at(index);
    let construct;
    let valueIndex;
    if (['die', 'deny'].includes(word) && at(index + 1) === '(') {
      construct = `${word}(`;
      valueIndex = index + 2;
    } else if (word === 'new' && ['Error', 'RunnerUsageError'].includes(at(index + 1)) && at(index + 2) === '(') {
      construct = `new ${at(index + 1)}(`;
      valueIndex = index + 3;
    } else if (word === 'problems' && at(index + 1) === '.' && at(index + 2) === 'push' && at(index + 3) === '(') {
      construct = 'problems.push(';
      valueIndex = index + 4;
    } else if (['reason', 'refusal', "'reason'", '"reason"', "'refusal'", '"refusal"'].includes(word)
        && ['{', ','].includes(at(index - 1)) && at(index + 1) === ':') {
      construct = `${word.replace(/['"]/g, '')}:`;
      valueIndex = index + 2;
    } else if (word === 'return') {
      if (/[\r\n]/.test(source.slice(tokens[index].end, tokens[index + 1]?.start))) continue;
      construct = 'return';
      valueIndex = index + 1;
    } else continue;
    while (at(valueIndex) === '(') valueIndex += 1;
    if (!tokens[valueIndex]?.literal) continue;
    const line = lineAt(source, tokens[valueIndex].start);
    if (!optOuts.has(line)) violations.push(`${file}:${line}: ${construct} carries a literal message`);
  }
  return { violations, optOuts: [...optOuts].map(([line, comment]) => `${file}:${line}: ${comment}`) };
}

function assertGuard(t, source, file) {
  const result = checkRefusalSites(source, file);
  for (const optOut of result.optOuts) t.diagnostic(`accepted opt-out: ${optOut}`);
  assert.deepEqual(result.violations, [], result.violations.join('\n'));
}

test('Plan_79 S1a-S1c lists 26 unique existing admission files', () => {
  assert.equal(ADMISSION_FILES.length, 26);
  assert.equal(new Set(ADMISSION_FILES).size, 26);
  for (const file of ADMISSION_FILES) assert.ok(fs.statSync(new URL(`../${file}`, import.meta.url)).isFile(), file);
  for (const file of PENDING_MIGRATION) assert.ok(ADMISSION_FILES.includes(file), file);
  for (const name of ['task-file', 'question-kind']) {
    assert.ok(!PENDING_MIGRATION.has(`src/home/lib/runner/${name}.mjs`));
  }
});

for (const file of ADMISSION_FILES) {
  test(`admission refusal guard: ${file}`, {
    skip: PENDING_MIGRATION.has(file) ? 'pending Plan_79 registry migration' : false,
  }, (t) => assertGuard(t, read(file), file));
}

const negativeFixtures = [
  ['die', 'die('], ['error', 'new Error('], ['runner-usage-error', 'new RunnerUsageError('],
  ['deny', 'deny('], ['reason', 'reason:'], ['refusal', 'refusal:'],
  ['problems-push', 'problems.push('], ['return', 'return'],
  ['template-builder', 'die('], ['opt-out-without-reason', 'deny('],
];
for (const [name, construct] of negativeFixtures) {
  test(`negative fixture reports exactly one literal refusal: ${name}`, () => {
    const file = `tests/fixtures/order-refusal-sites/${name}.mjs.txt`;
    const result = checkRefusalSites(read(file), file);
    assert.deepEqual(result.violations, [`${file}:2: ${construct} carries a literal message`]);
    assert.deepEqual(result.optOuts, []);
  });
}

test('positive fixture permits registry builders and message identifiers', (t) => {
  const file = 'tests/fixtures/order-refusal-sites/positive.mjs.txt';
  assertGuard(t, read(file), file);
});

test('comments, strings, regexes, templates and division do not invent refusal sites', (t) => {
  const source = [
    '// die("comment"); return "comment";', '/* new Error("comment"); */',
    'const text = "deny(\\"quoted text\\") // not a comment";',
    'const template = `return "template text"; /* not a comment */`;',
    'const regex = /["\x27/]deny\\("not code"\\)/;',
    'const divided = count / 2; die(orderRuleMessage("key"));',
    'const url = "https://example.invalid/*literal*/"; deny(message);',
    'const result = { reason: condition ? message : otherMessage };',
    'function noValue() { return\n"an unrelated expression"; }',
  ].join('\n');
  assertGuard(t, source, 'lexical-controls');
});

test('all constructs reject templates as well as quoted literals after comments and grouping', () => {
  for (const [name, construct] of negativeFixtures.slice(0, 8)) {
    const source = read(`tests/fixtures/order-refusal-sites/${name}.mjs.txt`);
    for (const value of [
      '"literal"', "'literal'", '`literal`', '`prefix ${orderRuleMessage("key")} suffix`',
      '`prefix ${orderDiagnosticMessage("key")} suffix`',
    ]) {
      const modified = source.replace(/(['"])literal message\1/, `/* before */ (${value})`);
      assert.deepEqual(checkRefusalSites(modified, name).violations,
        [`${name}:2: ${construct} carries a literal message`]);
    }
  }
});

test('multiline comments preserve original diagnostic lines and templates expose expression code', () => {
  const source = '/* die("ignored");\n ignored */\nnew /* between */ Error(\n "literal // still text");';
  for (const text of [source, source.replace(/\n/g, '\r\n')]) {
    assert.deepEqual(checkRefusalSites(text, 'multiline').violations,
      ['multiline:4: new Error( carries a literal message']);
  }
  assert.deepEqual(checkRefusalSites('const text = `${deny("literal")}`;', 'interpolation').violations,
    ['interpolation:1: deny( carries a literal message']);
  const nested = 'const text = `${`nested ${identifier}`}`; deny("literal");';
  assert.deepEqual(checkRefusalSites(nested, 'nested-template').violations,
    ['nested-template:1: deny( carries a literal message']);
});

test('reasoned trailing opt-outs are accepted and printed, never supplied by literal text', (t) => {
  const source = 'return "status"; // order-guard: not-a-refusal — returns informational status';
  const result = checkRefusalSites(source, 'opt-out');
  assert.equal(result.optOuts.length, 1);
  assertGuard(t, source, 'opt-out');
  for (const reason of ['', 'status', 'status value', '... ... ...']) {
    const invalid = `deny("literal"); // order-guard: not-a-refusal — ${reason}`;
    assert.equal(checkRefusalSites(invalid, 'short-reason').violations.length, 1);
  }
  for (const fake of [
    '// order-guard: not-a-refusal — unrelated standalone comment\ndeny("literal");',
    'deny("// order-guard: not-a-refusal — text inside message");',
    'deny("literal"); /* order-guard: not-a-refusal — not a line comment */',
  ]) assert.equal(checkRefusalSites(fake, 'fake-opt-out').violations.length, 1);
});
