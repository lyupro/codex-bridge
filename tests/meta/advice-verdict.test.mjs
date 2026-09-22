import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempTree } from '../temp-tree.mjs';
import { judgeAdvice } from '../../src/home/lib/meta/advice-verdict.mjs';
import { advisorSchema, PHASE_SCHEMAS, SCHEMAS } from '../../src/home/lib/runner/schemas.mjs';

const suiteRoot = makeTempTree('advisor-verdict-');
const repoRoot = path.join(suiteRoot, 'repo');
const files = {
  'src/entry.mjs': 'first\nsecond\nthird\n',
  'src/nested/other.mjs': 'first\nsecond',
  'src/with space.mjs': 'first\n',
  'src/пример.mjs': 'first\n',
  'src/empty.mjs': '',
  'src-extra/hidden.mjs': 'outside the declared directory\n',
  'docs/guide.md': 'first\r\nsecond\r\nthird\r\n',
  'README': 'first\rsecond',
};
for (const [file, content] of Object.entries(files)) {
  const absolute = path.join(repoRoot, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}
const outside = path.join(suiteRoot, 'outside');
fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'external.mjs'), 'external evidence\n');
fs.symlinkSync(outside, path.join(repoRoot, 'src', 'escape'), 'junction');
fs.symlinkSync(path.join(repoRoot, 'src'), path.join(repoRoot, 'linked-src'), 'junction');

function validAdvice() {
  return {
    recommendation: { option_id: 'keep', text: 'Keep the current boundary.' },
    why: ['The entry point is explicit at src/entry.mjs:1.', 'The second line is stable.', 'No caller migration is needed.'],
    rejected: [{ option_id: 'split', cost: 'Requires a coordinated caller migration.' }],
    strongest_counterargument: 'The existing boundary may retain coupling as more callers arrive, requiring a later coordinated migration.',
    question_defect: 'none',
    assumptions: [],
    falsifier: 'A new caller requiring separate lifecycle ownership would overturn this decision.',
    confidence: 'medium',
    independent_checks: [{ check: 'Read the entry point.', address: 'src/entry.mjs:1-3' }],
  };
}

function input(phase = 'advise') {
  return {
    phase,
    result: phase === 'advise' ? validAdvice() : {
      sufficient: true, missing_paths: [], taken_on_trust: ['The supplied requirements describe the intended caller.'],
    },
    task: { options: [{ id: 'keep', description: 'Keep' }, { id: 'split', description: 'Split' }, { id: 'later', description: 'Wait' }], paths: ['src'] },
    repoRoot, commandsRun: 1, language: 'English',
  };
}

function passes(value) { assert.deepEqual(judgeAdvice(value), { ok: true, reasons: [] }); }
function fails(value, field, offending) {
  const verdict = judgeAdvice(value);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((reason) => reason.includes(field) && reason.includes(offending)), JSON.stringify(verdict));
}

test('accepts both phases, leaves unused options alone and does not mutate inputs or evidence', () => {
  for (const phase of ['scope', 'advise']) {
    const value = input(phase);
    const before = structuredClone(value);
    passes(value);
    assert.deepEqual(value, before);
  }
  assert.equal(fs.readFileSync(path.join(repoRoot, 'src/entry.mjs'), 'utf8'), files['src/entry.mjs']);
});

for (const phase of ['scope', 'advise']) {
  test(`D4 ${phase} requires at least one command`, () => {
    const value = input(phase);
    passes(value);
    value.commandsRun = 0;
    fails(value, 'commandsRun', '0');
  });
}

test('D4 scope names what was taken on trust', () => {
  const value = input('scope');
  passes(value);
  value.result.taken_on_trust = [];
  fails(value, 'taken_on_trust', '[]');
});
test('D4 insufficient scope must name missing paths', () => {
  const value = input('scope');
  value.result.sufficient = false;
  value.result.missing_paths = ['docs/guide.md'];
  passes(value);
  value.result.missing_paths = [];
  fails(value, 'missing_paths', 'sufficient false');
});
test('D4 sufficient scope cannot also name missing paths', () => {
  const value = input('scope');
  passes(value);
  value.result.missing_paths = ['docs/guide.md'];
  fails(value, 'missing_paths', 'docs/guide.md');
});
for (const [name, change, field, offending] of [
  ['unknown recommendation', (r) => { r.recommendation.option_id = 'invented'; }, 'recommendation.option_id', 'invented'],
  ['unknown rejection', (r) => { r.rejected.push({ option_id: 'invented', cost: 'Unknown' }); }, 'rejected[1].option_id', 'invented'],
  ['rejecting the recommendation', (r) => { r.rejected[0].option_id = 'keep'; }, 'rejected[0].option_id', 'keep'],
]) {
  test(`D5 refuses ${name}`, () => {
    const value = input();
    passes(value);
    change(value.result);
    fails(value, field, offending);
  });
}

function putCitation(result, field, address) {
  if (field === 'why[0]') result.why[0] = `Evidence at ${address}.`;
  else if (field === 'independent_checks[0].address') result.independent_checks[0].address = address;
  else result[field] += ` Evidence at ${address}.`;
}
for (const field of ['why[0]', 'strongest_counterargument', 'falsifier', 'independent_checks[0].address']) {
  for (const address of ['src/missing.mjs:1', 'src/entry.mjs:4', 'docs/guide.md:1']) {
    test(`D3 validates ${address} in ${field}`, () => {
      const value = input();
      putCitation(value.result, field, 'src/entry.mjs:1-3');
      passes(value);
      putCitation(value.result, field, address);
      fails(value, field, address);
    });
  }
}

for (const address of ['src/entry.mjs:0', 'src/entry.mjs:2-1', 'src/entry.mjs:1-4', 'src/entry.mjs:9007199254740993', 'src/empty.mjs:1']) {
  test(`D3 rejects invalid line bounds ${address}`, () => {
    const value = input();
    passes(value);
    value.result.independent_checks[0].address = address;
    fails(value, 'independent_checks[0].address', address);
  });
}

test('D3 counts CRLF, lone CR, final newlines and files without extensions', () => {
  const value = input();
  value.task.paths = ['.'];
  for (const [file, count] of [['docs/guide.md', 3], ['src/nested/other.mjs', 2], ['README', 2]]) {
    value.result.independent_checks[0].address = `${file}:1-${count}`;
    passes(value);
    value.result.independent_checks[0].address = `${file}:${count + 1}`;
    fails(value, 'independent_checks[0].address', `${file}:${count + 1}`);
  }
});

test('D3 normalizes backslashes and leading ./ in citations and declared paths', () => {
  const value = input();
  value.task.paths = ['.\\src\\entry.mjs'];
  value.result.why[0] = 'Evidence at .\\src\\entry.mjs:1-2 and ./src/entry.mjs:3.';
  value.result.independent_checks[0].address = '.\\src\\entry.mjs:1-3';
  passes(value);
});
test('D3 directory scopes include descendants but not sibling prefixes; file scopes stay exact', () => {
  const value = input();
  value.result.independent_checks[0].address = 'src/nested/other.mjs:2';
  passes(value);
  value.result.independent_checks[0].address = 'src-extra/hidden.mjs:1';
  fails(value, 'independent_checks[0].address', 'src-extra/hidden.mjs:1');
  value.task.paths = ['src/entry.mjs'];
  value.result.independent_checks[0].address = 'src/entry.mjs:1';
  passes(value);
  value.result.independent_checks[0].address = 'src/nested/other.mjs:1';
  fails(value, 'independent_checks[0].address', 'src/nested/other.mjs:1');
});

test('D3 checks every citation and every independent check, including later array entries', () => {
  const value = input();
  for (const text of ['Read `src/entry.mjs:1`, (src/entry.mjs:2-3), and src/nested/other.mjs:2.', '"See src/entry.mjs:1 and src/nested/other.mjs:2"', '"See src/entry.mjs:1"']) {
    value.result.why[2] = text;
    passes(value);
  }
  value.result.why[2] = '"See src/entry.mjs:1 and src/missing.mjs:1"';
  fails(value, 'why[2]', 'src/missing.mjs:1');
  value.result.why[2] = 'Read src/entry.mjs:1.';
  value.result.independent_checks.push({ check: 'Second check', address: 'src/missing.mjs:1' });
  fails(value, 'independent_checks[1].address', 'src/missing.mjs:1');
});
test('D3 supports Unicode paths and quoted paths with spaces', () => {
  const value = input();
  value.result.why = ['Read `src/with space.mjs:1`.', 'Read "src/with space.mjs:1".', "Read 'src/пример.mjs:1'."];
  value.result.independent_checks[0].address = 'src/with space.mjs:1';
  passes(value);
  value.result.why[1] = 'Read "src/with space.mjs:2".';
  fails(value, 'why[1]', 'src/with space.mjs:2');
});
test('D3 scope missing_paths authorizes exact files or directories only in scope', () => {
  for (const missing of ['docs/guide.md', 'docs']) {
    const value = input('scope');
    value.result.sufficient = false;
    value.result.missing_paths = [missing];
    value.result.independent_checks = [{ check: 'Read the missing dependency', address: 'docs/guide.md:2' }];
    passes(value);
    value.result.missing_paths = ['src'];
    fails(value, 'independent_checks[0].address', 'docs/guide.md:2');
  }
  const value = input();
  value.result.missing_paths = ['docs'];
  value.result.independent_checks[0].address = 'docs/guide.md:1';
  fails(value, 'independent_checks[0].address', 'docs/guide.md:1');
});
for (const address of ['../outside/external.mjs:1', 'src/escape/external.mjs:1', 'src/../docs/guide.md:1', 'C:\\elsewhere\\entry.mjs:1', '/elsewhere/entry.mjs:1', 'src:1']) {
  test(`D3 rejects evidence escaping its root or declared scope: ${address}`, () => {
    const value = input();
    passes(value);
    value.result.independent_checks[0].address = address;
    fails(value, 'independent_checks[0].address', address.replaceAll('\\', '\\\\'));
  });
}

test('D3 checks traversal and symlink escapes in prose, and allows internal directory links', () => {
  const value = input();
  value.task.paths.push('linked-src');
  value.result.independent_checks[0].address = 'linked-src/entry.mjs:1';
  passes(value);
  value.result.why[0] = 'Evidence at src/escape/external.mjs:1 and ../outside/external.mjs:1.';
  fails(value, 'why[0]', 'src/escape/external.mjs:1');
  fails(value, 'why[0]', '../outside/external.mjs:1');
});

for (const address of ['', 'checked manually', 'src/entry.mjs', 'src/entry.mjs:1-bad', 'src/entry.mjs:1:2']) {
  test(`D3 requires a resolvable independent address: ${JSON.stringify(address)}`, () => {
    const value = input();
    passes(value);
    value.result.independent_checks[0].address = address;
    fails(value, 'independent_checks[0].address', address);
  });
}

const phrases = {
  English: ['both options are good', 'it depends on preference', 'you know better', 'either works'],
  Russian: ['оба варианта хороши', 'зависит от предпочтений', 'вам виднее', 'подойдёт любой'],
};
for (const [language, list] of Object.entries(phrases)) {
  for (const phrase of list) {
    test(`D5 ${language} backstop is case/punctuation insensitive: ${phrase}`, () => {
      for (const selected of [language, 'unknown']) {
        const value = input();
        value.language = selected;
        passes(value);
        for (const text of [phrase.toUpperCase().split(' ').join(' — ') + '!', [...phrase].join('.')]) {
          value.result.recommendation.text = text;
          fails(value, 'recommendation.text', phrase);
        }
      }
    });
  }
}

test('D5 language selects its own list; unrelated words do not become a backstop', () => {
  const value = input();
  value.result.recommendation.text = 'Оба варианта хороши.';
  passes(value);
  value.language = 'Russian';
  value.result.recommendation.text = 'Either works.';
  passes(value);
  value.language = 'English';
  value.result.recommendation.text = 'Either workshop can supply callers.';
  passes(value);
});

for (const field of ['why', 'rejected', 'strongest_counterargument', 'question_defect', 'assumptions', 'falsifier', 'independent_checks']) {
  test(`D5 scans prose in ${field}`, () => {
    const value = input();
    passes(value);
    if (field === 'rejected') value.result.rejected[0].cost = 'You know better.';
    else if (field === 'independent_checks') value.result.independent_checks[0].check = 'You know better.';
    else if (Array.isArray(value.result[field])) value.result[field].push('You know better.');
    else value.result[field] = 'You know better.';
    fails(value, field, 'you know better');
  });
}

test('required judgement context and unknown phases fail loudly', () => {
  for (const key of ['commandsRun', 'language', 'repoRoot', 'result', 'task']) {
    const value = input();
    delete value[key];
    assert.throws(() => judgeAdvice(value), TypeError);
  }
  assert.throws(() => judgeAdvice({ ...input(), phase: 'other' }), /phase/);
});

// Plan_59 requires an independent test validator rather than accepting our own schema by inspection.
function validates(schema, value) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type !== type) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (type === 'string') {
    const length = [...value].length;
    return !(schema.minLength !== undefined && length < schema.minLength) &&
      !(schema.maxLength !== undefined && length > schema.maxLength) &&
      (!schema.pattern || new RegExp(schema.pattern, 'u').test(value));
  }
  if (type === 'array') {
    return !(schema.minItems !== undefined && value.length < schema.minItems) &&
      !(schema.maxItems !== undefined && value.length > schema.maxItems) &&
      value.every((item) => validates(schema.items, item));
  }
  if (type === 'object') {
    return schema.required.every((key) => Object.hasOwn(value, key)) &&
      Object.entries(value).every(([key, item]) => Object.hasOwn(schema.properties, key)
        ? validates(schema.properties[key], item) : schema.additionalProperties !== false);
  }
  return true;
}
function* requiredPaths(schema, value, prefix = []) {
  if (schema.type === 'object') {
    for (const key of schema.required) yield [...prefix, key];
    for (const [key, child] of Object.entries(schema.properties)) yield* requiredPaths(child, value[key], [...prefix, key]);
  } else if (schema.type === 'array') {
    for (const [index, item] of value.entries()) yield* requiredPaths(schema.items, item, [...prefix, index]);
  }
}

test('advisor schemas are looked up by role and phase without registering an execution agent', () => {
  assert.deepEqual(Object.keys(SCHEMAS), ['codex-scout', 'codex-build', 'codex-review']);
  for (const phase of ['scope', 'advise']) {
    assert.equal(advisorSchema(phase), PHASE_SCHEMAS.advisor[phase]);
    assert.equal(validates(advisorSchema(phase), input(phase).result), true);
  }
  for (const phase of [undefined, '', 'other', 'toString', '__proto__']) assert.throws(() => advisorSchema(phase), RangeError);
});

test('every schema object has all properties required, disallows extras and has no defaults', () => {
  function inspect(schema) {
    assert.equal(Object.hasOwn(schema, 'default'), false);
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(inspect);
    } else if (schema.type === 'array') inspect(schema.items);
  }
  inspect(advisorSchema('scope'));
  inspect(advisorSchema('advise'));
});

for (const phase of ['scope', 'advise']) {
  const schema = advisorSchema(phase);
  for (const keys of requiredPaths(schema, input(phase).result)) {
    test(`${phase} schema rejects removal of required ${keys.join('.')}`, () => {
      const value = input(phase).result;
      assert.equal(validates(schema, value), true);
      const parent = keys.slice(0, -1).reduce((object, key) => object[key], value);
      delete parent[keys.at(-1)];
      assert.equal(validates(schema, value), false);
    });
  }
}

for (const [name, change] of [
  ['short why', (r) => { r.why = ['one', 'two']; }],
  ['long why', (r) => { r.why = Array(6).fill('reason'); }],
  ['empty rejected', (r) => { r.rejected = []; }],
  ['short counterargument', (r) => { r.strongest_counterargument = 'x'.repeat(79); }],
  ['short falsifier', (r) => { r.falsifier = 'x'.repeat(19); }],
  ['invalid confidence', (r) => { r.confidence = 'certain'; }],
  ['empty checks', (r) => { r.independent_checks = []; }],
  ['long recommendation', (r) => { r.recommendation.text = 'x'.repeat(301); }],
  ...['\n', '\r', '\u2028', '\u2029'].flatMap((newline) => [
    ['multiline recommendation', (r) => { r.recommendation.text = `First${newline}Second`; }],
    ['trailing line terminator', (r) => { r.recommendation.text = `First${newline}`; }],
  ]),
  ['wrong type', (r) => { r.assumptions = 'none'; }],
  ['wrong array item type', (r) => { r.why[0] = 1; }],
  ['null object', (r) => { r.recommendation = null; }],
  ['top-level extra', (r) => { r.extra = true; }],
  ['recommendation extra', (r) => { r.recommendation.extra = true; }],
  ['rejected extra', (r) => { r.rejected[0].extra = true; }],
  ['check extra', (r) => { r.independent_checks[0].extra = true; }],
]) {
  test(`advise schema rejects ${name}`, () => {
    const value = validAdvice();
    assert.equal(validates(advisorSchema('advise'), value), true);
    change(value);
    assert.equal(validates(advisorSchema('advise'), value), false);
  });
}

test('schema length boundaries, all confidence values and scope types are enforced', () => {
  const value = validAdvice();
  value.recommendation.text = 'x'.repeat(300);
  value.strongest_counterargument = 'x'.repeat(80);
  value.falsifier = 'x'.repeat(20);
  value.why = Array(5).fill('reason');
  for (const confidence of ['high', 'medium', 'low']) {
    value.confidence = confidence;
    assert.equal(validates(advisorSchema('advise'), value), true);
  }
  for (const patch of [{ sufficient: 'true' }, { missing_paths: [1] }, { taken_on_trust: [] }]) {
    assert.equal(validates(advisorSchema('scope'), input('scope').result), true);
    assert.equal(validates(advisorSchema('scope'), { ...input('scope').result, ...patch }), false);
  }
});
