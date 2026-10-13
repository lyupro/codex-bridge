// Plan_79 D3: refusal-guard rules live in ./order-guard/refusal-checker.mjs.
// Keep this file focused on admission coverage and guard regression tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lineAt } from './order-guard/lexer.mjs';
import { checkRefusalSites } from './order-guard/refusal-checker.mjs';
import { ADMISSION_FILES, PENDING_MIGRATION } from './order-guard/admission-files.mjs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

function assertGuard(t, source, file) {
  const result = checkRefusalSites(source, file);
  for (const optOut of result.optOuts) t.diagnostic(`accepted opt-out: ${optOut}`);
  assert.deepEqual(result.violations, [], result.violations.join('\n'));
}

// 26 files from the S1a-S1c inventory plus the four producers B4g found forwarded by preflight.mjs.
// Plan_79 B4h also admits sandbox-probe.mjs and sandbox-diagnosis.mjs.
// Plan_79 B5a admits subagent-model-env.mjs before the hook forwards its refusal.
// Plan_79 B5b1 admits the dispatcher hook and shared protocol catalog and migrates the gate.
test('Plan_79 S1a-S1c and B4g/B4h/B5a/B5b1 list 35 unique existing admission files', () => {
  assert.equal(ADMISSION_FILES.length, 35);
  assert.equal(new Set(ADMISSION_FILES).size, 35);
  for (const file of ADMISSION_FILES) assert.ok(fs.statSync(new URL(`../${file}`, import.meta.url)).isFile(), file);
  for (const file of PENDING_MIGRATION) assert.ok(ADMISSION_FILES.includes(file), file);
  for (const name of ['task-file', 'question-kind', 'task-input', 'order-options', 'sandbox-probe', 'sandbox-diagnosis']) {
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
  ['concatenation-name', 'die('], ['concatenation-grouped', 'die('], ['array-joined', 'die('],
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

for (const [name, line, identifier] of [['const-message', 2, 'message'], ['reassigned-reason', 3, 'reason']]) {
  test(`same-file literal binding rejects fixture: ${name}`, () => {
    const file = `tests/fixtures/order-refusal-sites/${name}.mjs.txt`;
    const result = checkRefusalSites(read(file), file);
    assert.deepEqual(result.violations, [`${file}:${line}: ${identifier} is a literal message`]);
    assert.deepEqual(result.optOuts, []);
  });
}

test('same-file literal bindings cover every refusal construct, declaration and assignment', () => {
  for (const [name] of negativeFixtures.slice(0, 8)) {
    const refusal = read(`tests/fixtures/order-refusal-sites/${name}.mjs.txt`).replace(/(['"])literal message\1/, '((message))');
    for (const binding of ['const message =', 'let message =', 'var message =', 'message =']) {
      for (const literal of ['"literal"', "'literal'", '`literal`', '`prefix ${orderRuleMessage("key")} suffix`', '`prefix ${orderDiagnosticMessage("key")} suffix`']) {
        const source = `${refusal}\n${binding} /* gap */ (\n${literal});`;
        for (const text of [source, source.replace(/\n/g, '\r\n')]) {
          assert.deepEqual(checkRefusalSites(text, name).violations,
            [`${name}:${lineAt(text, text.indexOf(literal))}: message is a literal message`]);
        }
      }
    }
  }
});

test('literal bindings use literal-line opt-outs and do not follow calls or other names', (t) => {
  assert.deepEqual(checkRefusalSites('const message = "first";\nmessage = `second`;\ndie(message).then(); deny(message);', 'multiple').violations, ['multiple:1: message is a literal message', 'multiple:2: message is a literal message']);
  assertGuard(t, 'const message = "status"; // order-guard: not-a-refusal — informational status only\ndie(message);', 'binding-opt-out');
  assert.equal(checkRefusalSites('const message = "literal";\ndie(message); // order-guard: not-a-refusal — informational status only', 'wrong-line').violations.length, 1);
  assertGuard(t, 'const other = "text"; const message = other; die(message);', 'no-data-flow');
  assertGuard(t, 'const { message } = input; function refuse(reason) { die(reason); } die(message);', 'unresolved-values');
  assertGuard(t, 'const { message = "default" } = input; function refuse(reason = "default") { die(reason); } die(message);', 'defaults');
  assertGuard(t, 'const [message = "default"] = input; const refuse = (reason = "default") => die(reason); die(message);', 'arrow-defaults');
  assertGuard(t, 'const builder = "text"; die((builder)("key"));', 'grouped-call');
  assertGuard(t, 'object.message = "text"; message === "text"; const message = builder("key"); die(message);', 'non-bindings');
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

for (const [name, line] of [['wrapper-arrow', 3], ['wrapper-declaration', 3], ['wrapper-chain', 5]]) {
  test(`forwarding wrapper rejects fixture: ${name}`, () => {
    const file = `tests/fixtures/order-refusal-sites/${name}.mjs.txt`;
    const result = checkRefusalSites(read(file), file);
    assert.deepEqual(result.violations, [`${file}:${line}: refuse( carries a literal message`]);
    assert.deepEqual(result.optOuts, []);
  });
}

test('forwarding wrapper fixture permits only builder calls as messages', (t) => {
  const file = 'tests/fixtures/order-refusal-sites/wrapper-positive.mjs.txt';
  assertGuard(t, read(file), file);
});

test('all function forms forward parameters through every refusal construct and message composition', () => {
  const bodies = [
    ['die(VALUE);', 'die('], ['deny(VALUE);', 'deny('], ['throw new Error(VALUE);', 'new Error('],
    ['throw new RunnerUsageError(VALUE);', 'new RunnerUsageError('], ['problems.push(VALUE);', 'problems.push('],
    ['const result = { reason: VALUE };', 'reason:'], ['const result = { refusal: VALUE };', 'refusal:'], ['return VALUE;', 'return'],
  ];
  const forms = [
    (body) => `function refuse(code, message) { ${body} }`,
    (body) => `const refuse = (code, message) => { ${body} };`,
    (body) => `const refuse = function (code, message) { ${body} };`,
  ];
  for (const [body, construct] of bodies) {
    for (const value of ['message', '((message))', '[message].filter(Boolean).join("\\n")', '"prefix " + message', '`prefix ${message}`']) {
      for (const form of forms) {
        const definition = form(body.replace('VALUE', value));
        for (const literal of ['"literal"', "'literal'", '`literal ${orderRuleMessage("key")}`']) {
          const source = `${definition}\nrefuse("unused argument", /* gap */ (\n${literal}));`;
          for (const text of [source, source.replace(/\n/g, '\r\n')]) {
            // D3 still rejects literal-leading messages at the definition as well as the wrapper call.
            const existing = /^["`]/.test(value) ? [`wrapper-matrix:1: ${construct} carries a literal message`] : [];
            assert.deepEqual(checkRefusalSites(text, 'wrapper-matrix').violations,
              [...existing, 'wrapper-matrix:3: refuse( carries a literal message']);
          }
        }
      }
    }
  }
});

test('forwarding wrappers retain message positions and reach a fixed point in either definition order', (t) => {
  const definitions = [
    'function refuse(message, code) { die(message, code); }',
    'const middle = (unused, message) => refuse(message, unused);',
    'const outer = function (message, unused) { middle(unused, message); };',
  ];
  for (const ordered of [definitions, definitions.toReversed()]) {
    const source = `${ordered.join('\n')}\nouter("literal", orderRuleMessage("key"));`;
    assert.deepEqual(checkRefusalSites(source, 'chain').violations, ['chain:4: outer( carries a literal message']);
    assertGuard(t, `${ordered.join('\n')}\nouter(orderRuleMessage("key"), "not a message");`, 'positions');
  }
  const multiple = 'function refuse(code, first, second) { die(first, code); deny(second); }';
  assert.deepEqual(checkRefusalSites(`${multiple}\nrefuse("code", "first", "second");`, 'multiple-positions').violations,
    ['multiple-positions:2: refuse( carries a literal message', 'multiple-positions:2: refuse( carries a literal message']);
  const cycle = 'const left = (message) => right(message); const right = (message) => { left(message); die(message); };';
  assert.deepEqual(checkRefusalSites(`${cycle}\nleft("literal");`, 'anchored-cycle').violations,
    ['anchored-cycle:2: left( carries a literal message']);
  assertGuard(t, 'const left = (message) => right(message); const right = (message) => left(message); left("data");', 'unanchored-cycle');
});

test('wrapper literals use original opening lines, binding tracing and reasoned opt-outs', (t) => {
  const definition = 'const refuse = message => die(message);';
  const source = `${definition}\nrefuse(\n "status"); // order-guard: not-a-refusal — informational status only`;
  assertGuard(t, source, 'wrapper-opt-out');
  assert.equal(checkRefusalSites(source, 'wrapper-opt-out').optOuts.length, 1);
  assert.deepEqual(checkRefusalSites(`${definition}\nrefuse(\n "literal"); // order-guard: not-a-refusal — too short`, 'short').violations,
    ['short:3: refuse( carries a literal message']);
  assert.deepEqual(checkRefusalSites(`${definition}\nconst message = "literal";\nrefuse(message);`, 'wrapper-binding').violations,
    ['wrapper-binding:2: message is a literal message']);
  assertGuard(t, `${definition}\nconst message = orderRuleMessage("key"); refuse(message);`, 'wrapper-builder-binding');
});

test('wrapper discovery ignores builder arguments, defaults, member calls and unrelated function bodies', (t) => {
  for (const definition of [
    'const format = message => die(orderRuleMessage("key", { message }));',
    'function format(message) { die(orderDiagnosticMessage("key", message)); }',
    'function format(message) { function inner(message) { die(message); } log(message); }',
    'const format = message => log(message);',
    'function format(message) { return\nmessage; }',
  ]) assertGuard(t, `${definition}\nformat("ordinary input");`, 'not-forwarded');
  assertGuard(t, 'const refuse = (message = "default") => die(message); object.refuse("ordinary input");', 'wrapper-default');
  assertGuard(t, 'const refuse = message => die(message); const text = "refuse(\\"text\\")"; // refuse("comment")', 'wrapper-lexical');
});

for (const [name, line, diagnostic] of [
  ['wrapper-concatenation', 3, 'refuse( carries'], ['wrapper-array', 3, 'refuse( carries'],
  ['binding-concatenation', 2, 'message is'], ['binding-array', 2, 'message is'],
]) {
  test(`message composition rejects fixture: ${name}`, () => {
    const file = `tests/fixtures/order-refusal-sites/${name}.mjs.txt`;
    const result = checkRefusalSites(read(file), file);
    assert.deepEqual(result.violations, [`${file}:${line}: ${diagnostic} a literal message`]);
    assert.deepEqual(result.optOuts, []);
  });
}

test('message composition fixture permits identifiers, builders and literal join separators', (t) => {
  const file = 'tests/fixtures/order-refusal-sites/composition-positive.mjs.txt';
  assertGuard(t, read(file), file);
});

test('all refusal constructs and traced bindings reject composed literal messages', () => {
  for (const [name, construct] of negativeFixtures.slice(0, 8)) {
    const refusal = read(`tests/fixtures/order-refusal-sites/${name}.mjs.txt`);
    for (const literal of ['"literal"', "'literal'", '`literal ${orderRuleMessage("key")}`']) {
      for (const expression of [
        `name +\n${literal}`, `(name + (\n${literal}))`, `name + (other +\n${literal})`,
        `[name,\n${literal}].join("\\n")`, `[name,\n${literal}]`,
        `[name,\n${literal}].filter(Boolean).join("\\n")`,
        `condition ? (name +\n${literal}) : other`, `name + [, (\n${literal})].join(" ")`,
        `typeof (name +\n${literal})`,
      ]) {
        const direct = refusal.replace(/(['"])literal message\1/, expression);
        const use = refusal.replace(/(['"])literal message\1/, '((message))');
        const wrapperBody = name === 'return' ? 'return ((message));' : use;
        const wrapper = `function refuse(message) { ${wrapperBody} }\nrefuse(${expression});`;
        for (const [source, diagnostic] of [
          [direct, `${construct} carries`], [wrapper, 'refuse( carries'],
          ...['const message =', 'let message =', 'var message =', 'message =']
            .map(binding => [`${use}\n${binding} ${expression};`, 'message is']),
        ]) {
          for (const text of [source, source.replace(/\n/g, '\r\n')]) {
            assert.deepEqual(checkRefusalSites(text, name).violations,
              [`${name}:${lineAt(text, text.indexOf(literal))}: ${diagnostic} a literal message`]);
          }
        }
      }
    }
  }
});

test('composition checks every literal opening line and honors only its own opt-out', () => {
  const source = 'die(name +\n "first" +\n `second`);\ndeny([name,\n "third",\n `fourth`].join("\\n"));';
  assert.deepEqual(checkRefusalSites(source, 'multiple').violations, [
    'multiple:2: die( carries a literal message', 'multiple:3: die( carries a literal message',
    'multiple:5: deny( carries a literal message', 'multiple:6: deny( carries a literal message',
  ]);
  const exempted = source.replace('"first" +', '"first" + // order-guard: not-a-refusal — informational status only');
  assert.deepEqual(checkRefusalSites(exempted, 'opt-out').violations, [
    'opt-out:3: die( carries a literal message', 'opt-out:5: deny( carries a literal message',
    'opt-out:6: deny( carries a literal message',
  ]);
});

test('message composition leaves call arguments and member indices opaque', (t) => {
  for (const expression of [
    'orderRuleMessage("key", { value: name + "text", parts: ["text"] }) + renderOrderHeaderHelp(agent)',
    '[name, orderDiagnosticMessage("key", ["text"])].join("\\n")',
    '[name, renderOrderHeaderHelp(agent)].filter(value => value + "text").join("\\n")',
    '(orderRuleMessage)("key" + "suffix") + (renderOrderHeaderHelp)(agent)',
    'messages["key"] + messages[name + "suffix"]',
    'format?.(name + "text", ["text"]) + messages?.[name + "key"]',
  ]) {
    assertGuard(t, `die(${expression});`, 'opaque');
    assertGuard(t, `const message = ${expression}; die(message);`, 'opaque-binding');
  }
});
