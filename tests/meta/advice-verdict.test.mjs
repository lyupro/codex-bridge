/** Guards the advisor evidence and answer contracts in Plan_59 D3/D4/D5/D10. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempTree } from '../temp-tree.mjs';
import { judgeAdvice } from '../../src/home/lib/meta/advice-verdict.mjs';
import { validAdvice, validScope } from './advisor-fixtures.mjs';

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


function input(phase = 'advise') {
  return {
    phase,
    result: phase === 'advise' ? validAdvice() : validScope(),
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
function location(file, line_start = 1, line_end = line_start) { return { file, line_start, line_end }; }
function locationFromAddress(address) {
  const match = address.match(/^(.+):(\d+)(?:-(\d+))?$/);
  return match
    ? location(match[1], Number(match[2]), match[3] === undefined ? Number(match[2]) : Number(match[3]))
    : location(address);
}
function setEvidence(item, address) { item.evidence = [locationFromAddress(address)]; }
function rejectsChange(name, make, change, field, offending) {
  test(name, () => {
    const value = make();
    passes(value);
    change(value.result, value);
    fails(value, field, offending);
  });
}

test('accepts both phases, leaves unused options alone and does not mutate inputs or evidence', () => {
  for (const value of [input('scope'), input(), withRisks(), noneOfThese(), { ...input(), result: { ...validAdvice(), assumptions: [], risk_outcomes: [], open_questions: [] } }]) {
    const before = structuredClone(value);
    passes(value);
    assert.deepEqual(value, before);
  }
  assert.equal(fs.readFileSync(path.join(repoRoot, 'src/entry.mjs'), 'utf8'), files['src/entry.mjs']);
});

// D3 is one definition over the whole answer, not a list of prose fields that new fields miss.
for (const [field, make, change] of [
  ['question_defect', input, (result) => { result.question_defect = 'The question ignores src/entry.mjs:99.'; }],
  ['recommendation.text', input, (result) => { result.recommendation.text = 'Keep src/entry.mjs:40.'; }],
  ['rejected[0].cost', input, (result) => { result.rejected[0].cost = 'Breaks src/entry.mjs:12.'; }],
  ['taken_on_trust[0]', () => input('scope'), (result) => { result.taken_on_trust[0] = 'Callers use src/entry.mjs:77.'; }],
  ['predicted_risks[0].risk', () => input('scope'), (result) => { result.predicted_risks[0].risk = 'Coupling at src/entry.mjs:55.'; }],
]) {
  rejectsChange(`D3 checks an unresolvable address in ${field}`, make, change, `D3 ${field}`, 'src/entry.mjs:');
}
rejectsChange('D3 checks risk outcome addresses without the phase-1 answer', input,
  (result) => { setEvidence(result.risk_outcomes[0], 'src/entry.mjs:9'); }, 'D3 risk_outcomes[0].evidence[0]', 'src/entry.mjs:9');

function noneOfThese() {
  const value = input();
  value.result.recommendation.option_id = 'none-of-these';
  value.result.unlisted_option = 'Use a separate adapter for caller state.';
  value.result.rejected = value.task.options.map(({ id }) => ({ option_id: id, cost: 'Does not isolate caller ownership.' }));
  return value;
}
function withRisks() { return { ...input(), scopeResult: input('scope').result }; }
function insufficientScope() {
  const value = input('scope');
  Object.assign(value.result, { sufficient: false, missing_paths: ['docs/guide.md'] });
  return value;
}
for (const row of [
  ...['scope', 'advise'].map((phase) => [`D4 ${phase} requires at least one command`, () => input(phase), (r, v) => { v.commandsRun = 0; }, 'commandsRun', '0']),
  ['D4 scope names what was taken on trust', () => input('scope'), (r) => { r.taken_on_trust = []; }, 'taken_on_trust', '[]'],
  ['D4 insufficient scope must name missing paths', insufficientScope, (r) => { r.missing_paths = []; }, 'missing_paths', 'sufficient false'],
  ['D4 sufficient scope cannot also name missing paths', () => input('scope'), (r) => { r.missing_paths = ['docs/guide.md']; }, 'missing_paths', 'docs/guide.md'],
  ['D5 refuses unknown recommendation', input, (r) => { r.recommendation.option_id = 'invented'; }, 'recommendation.option_id', 'invented'],
  ['D5 refuses unknown rejection', input, (r) => { r.rejected.push({ option_id: 'invented', cost: 'Unknown' }); }, 'rejected[1].option_id', 'invented'],
  ['D5 refuses rejecting the recommendation', input, (r) => { r.rejected[0].option_id = 'keep'; }, 'rejected[0].option_id', 'keep'],
  ...['src/entry.mjs:0', 'src/entry.mjs:2-1', 'src/entry.mjs:1-4', 'src/entry.mjs:9007199254740992', 'src/empty.mjs:1'].map((address) =>
    [`D3 rejects invalid line bounds ${address}`, input, (r) => { setEvidence(r.independent_checks[0], address); }, 'independent_checks[0].evidence[0]', address]),
  ...['../outside/external.mjs:1', 'src/escape/external.mjs:1', 'src/../docs/guide.md:1', 'C:\\elsewhere\\entry.mjs:1', '/elsewhere/entry.mjs:1', 'src:1'].map((address) =>
    [`D3 rejects evidence escaping its root or declared scope: ${address}`, input, (r) => { setEvidence(r.independent_checks[0], address); }, 'independent_checks[0].evidence[0]', address.replaceAll('\\', '\\\\')]),
  ...['', 'checked manually', 'src/entry.mjs/child', 'src/entry.mjs:1-bad', 'src/entry.mjs:1:2'].map((address) =>
    [`D3 requires a resolvable independent location: ${JSON.stringify(address)}`, input, (r) => { setEvidence(r.independent_checks[0], address); }, 'independent_checks[0].evidence[0]', address]),
  ...['none', 'x'.repeat(39), '', ' '.repeat(40)].map((text) => ['D10 none-of-these requires a description ' + JSON.stringify(text), noneOfThese, (r) => { r.unlisted_option = text; }, 'unlisted_option', JSON.stringify(text)]),
  ['D10 task options cannot describe an unlisted option', input, (r) => { r.unlisted_option = 'A different boundary.'; }, 'unlisted_option', 'none'],
  ['D10 none-of-these names every missing rejection', noneOfThese, (r) => { r.rejected = r.rejected.slice(1, 2); }, 'rejected', '["keep","later"]'],
  ['D10 scope rejects duplicate risk ids with different descriptions', () => input('scope'), (r) => { r.predicted_risks[2] = { id: 'r1', risk: 'Another risk.' }; }, 'predicted_risks[2].id', 'r1'],
  ['D10 missing risk outcome', withRisks, (r) => { r.risk_outcomes.pop(); }, 'risk_outcomes', '"r3" count 0'],
  ['D10 duplicate risk outcome', withRisks, (r) => { r.risk_outcomes.push({ ...r.risk_outcomes[0], outcome: 'refuted' }); }, 'risk_outcomes', '"r1" count 2'],
  ['D10 unknown risk outcome', withRisks, (r) => { r.risk_outcomes.push({ risk_id: 'r4', outcome: 'confirmed', note: 'Unknown risk.', evidence: [location('src/entry.mjs')] }); }, 'risk_outcomes[3].risk_id', 'r4'],
  ...['', 'src/missing.mjs:1', 'src/entry.mjs:4', 'docs/guide.md:1'].map((address) => ['D10 risk outcome citation ' + JSON.stringify(address), withRisks, (r) => { setEvidence(r.risk_outcomes[2], address); }, 'risk_outcomes[2].evidence[0]', address]),
  ...[1, 2].map((index) => [`D10 nonempty assumption evidence ${index} requires a valid location`, input, (r) => { setEvidence(r.assumptions[index], 'src/missing.mjs:1'); }, `assumptions[${index}].evidence[0]`, 'src/missing.mjs:1']),
]) rejectsChange(...row);

test('D10 VERIFIED assumptions with no evidence return the specific reason', () => {
  const value = input();
  value.result.assumptions[0].evidence = [];
  assert.deepEqual(judgeAdvice(value).reasons, [
    'D10 assumptions[0].evidence []: a VERIFIED assumption needs at least one location.',
  ]);
});

test('D10 inspect checks with no evidence return the specific reason', () => {
  const value = input();
  value.result.pre_mortem[0].early_check.evidence = [];
  assert.deepEqual(judgeAdvice(value).reasons, [
    'D10 pre_mortem[0].early_check.evidence []: an inspect check needs at least one location.',
  ]);
});

function putCitation(result, field, address) {
  const keys = field.replaceAll('[', '.').replaceAll(']', '').split('.');
  const parent = keys.slice(0, -1).reduce((object, key) => object[key], result);
  if (field.endsWith('.evidence[0]')) parent[keys.at(-1)] = locationFromAddress(address);
  else if (field.endsWith('.target')) parent[keys.at(-1)] = address;
  else parent[keys.at(-1)] = `${parent[keys.at(-1)] ?? ''} Evidence at ${address}.`;
}
for (const field of ['why[0]', 'strongest_counterargument', 'pre_mortem[0].scenario', 'open_questions[1]',
  'independent_checks[0].evidence[0]', ...[0, 1, 2].map((index) => `assumptions[${index}].evidence[0]`)]) {
  for (const address of ['src/missing.mjs:1', 'src/entry.mjs:4', 'docs/guide.md:1']) {
    rejectsChange(`D3 validates ${address} in ${field}`,
      () => { const value = input(); putCitation(value.result, field, 'src/entry.mjs:1-3'); return value; },
      (result) => putCitation(result, field, address), field, address);
  }
}

test('D3 counts CRLF, lone CR, final newlines and files without extensions', () => {
  const value = input();
  value.task.paths = ['.'];
  for (const [file, count] of [['docs/guide.md', 3], ['src/nested/other.mjs', 2], ['README', 2]]) {
    value.result.independent_checks[0].evidence = [location(file, 1, count)];
    passes(value);
    value.result.independent_checks[0].evidence = [location(file, count + 1)];
    fails(value, 'independent_checks[0].evidence[0]', `${file}:${count + 1}`);
  }
});

test('D3 normalizes backslashes and leading ./ in citations and declared paths', () => {
  const value = input();
  value.task.paths = ['.\\src\\entry.mjs'];
  value.result.why[0] = 'Evidence at .\\src\\entry.mjs:1-2 and ./src/entry.mjs:3.';
  value.result.independent_checks[0].evidence = [location('.\\src\\entry.mjs', 1, 3)];
  passes(value);
});
test('D3 directory scopes include descendants but not sibling prefixes; file scopes stay exact', () => {
  const value = input();
  value.result.independent_checks[0].evidence = [location('src/nested/other.mjs', 2)];
  passes(value);
  value.result.independent_checks[0].evidence = [location('src-extra/hidden.mjs')];
  fails(value, 'independent_checks[0].evidence[0]', 'src-extra/hidden.mjs:1');
  value.task.paths = ['src/entry.mjs'];
  value.result.independent_checks[0].evidence = [location('src/entry.mjs')];
  passes(value);
  value.result.independent_checks[0].evidence = [location('src/nested/other.mjs')];
  fails(value, 'independent_checks[0].evidence[0]', 'src/nested/other.mjs:1');
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
  value.result.independent_checks.push({ check: 'Second check', evidence: [location('src/missing.mjs')] });
  fails(value, 'independent_checks[1].evidence[0]', 'src/missing.mjs:1');
});

test('D3 accepts several locations as separate evidence objects for one independent check', () => {
  const value = input();
  value.result.independent_checks[0].evidence = [
    location('src/entry.mjs', 1, 3), location('src/nested/other.mjs', 1, 2),
    location('src/with space.mjs'), location('src/пример.mjs'),
  ];
  passes(value);
});

test('D3 rejects a location outside task paths and scope missing_paths', () => {
  const value = input();
  value.scopeResult = { ...validScope(), missing_paths: ['docs/guide.md'] };
  value.result.independent_checks[0].evidence = [location('src-extra/hidden.mjs')];
  fails(value, 'independent_checks[0].evidence[0]', 'src-extra/hidden.mjs:1');
});

test('D3 rejects descending evidence ranges', () => {
  const value = input();
  value.result.independent_checks[0].evidence = [location('src/entry.mjs', 3, 2)];
  fails(value, 'independent_checks[0].evidence[0]', 'ascending line range');
});

test('D3 skips structured evidence strings in the prose scan', () => {
  const value = input();
  value.result.independent_checks[0].evidence = [location('src/entry.mjs:1')];
  const verdict = judgeAdvice(value);
  assert.equal(verdict.reasons.length, 1);
  assert.match(verdict.reasons[0], /independent_checks\[0\]\.evidence\[0\]/);
  assert.doesNotMatch(verdict.reasons[0], /\.file/);
});

test('early_check.target remains free text when it contains an address-like string', () => {
  const value = input();
  for (const kind of ['inspect', 'test', 'command']) {
    value.result.pre_mortem[0].early_check.kind = kind;
    for (const target of ['src/entry.mjs', 'src/missing.mjs:1', 'src/entry.mjs:1-bad']) {
      value.result.pre_mortem[0].early_check.target = target;
      passes(value);
    }
  }
});

test('D3 checks inspect evidence separately from its free-text target', () => {
  const value = input();
  value.result.pre_mortem[0].early_check.target = 'src/entry.mjs';
  value.result.pre_mortem[0].early_check.evidence = [location('src/missing.mjs')];
  fails(value, 'pre_mortem[0].early_check.evidence[0]', 'src/missing.mjs:1');
});

test('D3 supports Unicode paths and quoted paths with spaces', () => {
  const value = input();
  value.result.why = ['Read `src/with space.mjs:1`.', 'Read "src/with space.mjs:1".', "Read 'src/пример.mjs:1'."];
  value.result.independent_checks[0].evidence = [location('src/with space.mjs')];
  passes(value);
  value.result.why[1] = 'Read "src/with space.mjs:2".';
  fails(value, 'why[1]', 'src/with space.mjs:2');
});
test('D3 scope missing_paths authorizes exact files or directories only in scope', () => {
  for (const missing of ['docs/guide.md', 'docs']) {
    const value = input('scope');
    value.result.sufficient = false;
    value.result.missing_paths = [missing];
    value.result.independent_checks = [{ check: 'Read the missing dependency', evidence: [location('docs/guide.md', 2)] }];
    passes(value);
    value.result.missing_paths = ['src'];
    fails(value, 'independent_checks[0].evidence[0]', 'docs/guide.md:2');
  }
  const value = input();
  value.result.missing_paths = ['docs'];
  value.result.independent_checks[0].evidence = [location('docs/guide.md')];
  fails(value, 'independent_checks[0].evidence[0]', 'docs/guide.md:1');
});
test('D3 advise accepts phase-1 missing_paths only when its scope result is available', () => {
  const value = input();
  value.scopeResult = { ...validScope(), sufficient: false, missing_paths: ['docs/guide.md'] };
  value.result.independent_checks[0].evidence = [location('docs/guide.md')];
  passes(value);
  delete value.scopeResult;
  fails(value, 'independent_checks[0].evidence[0]', 'docs/guide.md:1');
});
test('D3 checks traversal and symlink escapes in prose, and allows internal directory links', () => {
  const value = input();
  value.task.paths.push('linked-src');
  value.result.independent_checks[0].evidence = [location('linked-src/entry.mjs')];
  passes(value);
  value.result.why[0] = 'Evidence at src/escape/external.mjs:1 and ../outside/external.mjs:1.';
  fails(value, 'why[0]', 'src/escape/external.mjs:1');
  fails(value, 'why[0]', '../outside/external.mjs:1');
});

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

for (const field of ['why[3]', 'rejected[0].cost', 'strongest_counterargument', 'question_defect', 'assumptions[0].claim', 'pre_mortem[0].scenario', 'open_questions[2]', 'unlisted_option', 'independent_checks[0].check']) {
  const name = field.match(/^\w+/)[0];
  rejectsChange(`D5 scans prose in ${name}`, input, (result) => putCitation(result, field, 'You know better.'), name, 'you know better');
}

test('required judgement context and unknown phases fail loudly', () => {
  for (const key of ['commandsRun', 'language', 'repoRoot', 'result', 'task']) {
    const value = input();
    delete value[key];
    assert.throws(() => judgeAdvice(value), TypeError);
  }
  assert.throws(() => judgeAdvice({ ...input(), phase: 'other' }), /phase/);
});

test('a scope answer with five predicted risks passes judgement', () => {
  const scope = input('scope');
  scope.result.predicted_risks.push(...['r8', 'r9'].map((id) => ({ id, risk: 'Another risk.' })));
  passes(scope);
});
