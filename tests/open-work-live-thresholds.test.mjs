/** Guards Plan_72 R3 B1: passed releases cannot silently strand pending operator live steps. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLiveThresholds } from '../scripts/open-work/live-thresholds.mjs';
import { parseRegister } from '../scripts/open-work/register.mjs';

const indexFile = 'docs/checklists/operator-checklists.md';
const versionFile = 'package.json';
const checklist = 'docs/checklists/Plan_72.md';
const group = { steps: ['4', '17б'], threshold: '0.6.9' };
const held = { ...group, work: 'OW-001' };

function row(groups = [group]) {
  return `- [Plan 72](Plan_72.md) live=${JSON.stringify(groups)}`;
}

function check({ indexText = `# Checklists\n\n## Актуальные\n${row()}\n`,
  version = '0.6.10', items = [] } = {}) {
  return checkLiveThresholds({ indexText, indexFile, version, versionFile, items });
}

function hold({ state = 'open', home = `${checklist} steps 17б, 4`, reason = 'Waiting for access',
  id = 'OW-001', extra = '' } = {}) {
  return parseRegister(`### ${id} — Live steps\n- состояние: ${state}\n- дом: ${home}\n`
    + `- блокер: ${reason}\n${extra}`).items;
}

function withGroup(value, options = {}) {
  return check({ ...options, indexText: `# Checklists\n\n## Актуальные\n${row([value])}\n` });
}

function diagnostic(text, file = indexFile, line = 4) {
  return { file, line, text };
}

function fails(result, pattern, line = 4) {
  assert.ok(result.violations.length, 'expected violations');
  assert.ok(result.violations.some((problem) => pattern.test(problem.text)), JSON.stringify(result));
  for (const problem of result.violations) {
    assert.equal(problem.file, indexFile);
    assert.equal(problem.line, line);
    assert.doesNotMatch(problem.text, /[\r\n]/);
  }
}

test('a later threshold waits silently', () => {
  assert.deepEqual(check({ version: '0.6.8' }), { violations: [], notices: [] });
});

test('an equal threshold reports the exact due notice', () => {
  assert.deepEqual(check({ version: '0.6.9' }), { violations: [], notices: [diagnostic(
    `due: ${checklist} steps 4, 17б wait for 0.6.9, the package is 0.6.9`,
  )] });
});

test('an older threshold reports the exact overdue violation, comparing 0.6.10 above 0.6.9', () => {
  assert.deepEqual(check(), { violations: [diagnostic(
    `overdue: ${checklist} steps 4, 17б waited for 0.6.9, the package is 0.6.10`,
  )], notices: [] });
});

test('version comparison uses all three integers, including integers beyond Number precision', () => {
  for (const [threshold, version] of [
    ['1.0.0', '0.99.99'], ['0.7.0', '0.6.99'], ['0.6.10', '0.6.9'],
    ['9007199254740993.0.0', '9007199254740992.99.99'],
  ]) assert.deepEqual(withGroup({ ...group, threshold }, { version }), { violations: [], notices: [] });
  assert.match(withGroup({ ...group, threshold: '0.6.09' }, { version: '0.06.9' }).notices[0].text, /^due:/);
});

for (const version of ['0.6', 'v0.6.9', '0.6.9-beta', '0.6.9\n', '', undefined, 9]) {
  test(`invalid package version ${JSON.stringify(version)} never compares groups`, () => {
    const result = checkLiveThresholds({ indexText: `## Актуальные\n${row()}`, indexFile,
      version, versionFile, items: [] });
    assert.deepEqual(result, { violations: [diagnostic(
      'package version must be a three-integer version', versionFile, 1,
    )], notices: [] });
  });
}

test('bad package version still checks marker shape', () => {
  const result = check({ version: 'bad', indexText: '## Актуальные\n- [Plan](Plan_72.md)' });
  assert.equal(result.violations.length, 2);
  assert.equal(result.violations[0].file, versionFile);
  assert.equal(result.violations[1].line, 2);
  assert.match(result.violations[1].text, /exactly one live=/);
  assert.deepEqual(result.notices, []);
});

test('missing active section is a source-located violation', () => {
  assert.deepEqual(check({ indexText: '# Index\n## Archived\n' }), {
    violations: [diagnostic('checklist index is missing the ## Актуальные section', indexFile, 1)], notices: [],
  });
});

test('only active lines before the next level-two heading are checked, with CRLF line numbers', () => {
  const indexText = ['# Index', '- [Ignored](old.md)', '## Актуальные', 'Prose',
    '### Subheading', '- [Plan](Plan_72.md) live=[]', '## Архив', '- [Ignored](old.md)'].join('\r\n');
  assert.deepEqual(check({ indexText }), { violations: [], notices: [] });
  fails(check({ indexText: indexText.replace(' live=[]', '') }), /exactly one live=/, 6);
});

for (const [name, text, pattern] of [
  ['missing marker', '- [Plan](Plan_72.md)', /exactly one live=/],
  ['two markers', '- [Plan](Plan_72.md) live=[] live=[]', /exactly one live=/],
  ['marker followed by prose', '- [Plan](Plan_72.md) live=[] trailing', /exactly one live=/],
  ['broken JSON', '- [Plan](Plan_72.md) live=[{]', /invalid JSON/],
  ['non-array marker', '- [Plan](Plan_72.md) live={}', /array marker/],
  ['missing markdown link', '- [Plan] live=[]', /markdown link/],
]) {
  test(name, () => {
    fails(check({ indexText: `# Index\n\n## Актуальные\n${text}` }), pattern);
  });
}

test('live=[] is valid and tail whitespace is accepted', () => {
  assert.deepEqual(check({ indexText: `## Актуальные\n${row([])}  \t` }), { violations: [], notices: [] });
});

for (const [name, value, pattern] of [
  ['null group', null, /must be an object/],
  ['array group', [], /must be an object/],
  ['string group', 'pending', /must be an object/],
  ['unknown key', { ...group, extra: true }, /unknown live group key: extra/],
  ['missing steps', { threshold: '0.6.9' }, /steps must be a non-empty array/],
  ['empty steps', { ...group, steps: [] }, /steps must be a non-empty array/],
  ['non-array steps', { ...group, steps: '4' }, /steps must be a non-empty array/],
  ['numeric step', { ...group, steps: [4] }, /step must match/],
  ['uppercase step', { ...group, steps: ['4A'] }, /step must match/],
  ['multiple suffix letters', { ...group, steps: ['17бб'] }, /step must match/],
  ['whitespace step', { ...group, steps: [' 4'] }, /step must match/],
  ['newline step', { ...group, steps: ['4\n'] }, /step must match/],
  ['duplicate step within group', { ...group, steps: ['4', '4'] }, /duplicate step 4/],
  ['missing threshold', { steps: ['4'] }, /threshold must be/],
  ['bad threshold', { ...group, threshold: '0.6' }, /threshold must be/],
  ['numeric threshold', { ...group, threshold: 9 }, /threshold must be/],
  ['newline threshold', { ...group, threshold: '0.6.9\n' }, /threshold must be/],
  ['none without work', { ...group, threshold: 'none' }, /none requires work/],
  ['short work id', { ...group, work: 'OW-01' }, /work must match OW-/],
  ['null work id', { ...group, work: null }, /work must match OW-/],
  ['newline work id', { ...group, work: 'OW-001\n' }, /work must match OW-/],
]) {
  test(name, () => fails(withGroup(value), pattern));
}

test('a step cannot appear in two groups on the same line', () => {
  fails(check({ indexText: `# Index\n\n## Актуальные\n${row([group, group])}` }), /more than one live group/);
});

test('step ownership is per line, and valid Latin and Cyrillic suffixes are accepted', () => {
  const value = { steps: ['4', '4a', '17б', '17ё'], threshold: '0.6.11' };
  const indexText = `## Актуальные\n${row([value])}\n${row([value])}`;
  assert.deepEqual(check({ indexText }), { violations: [], notices: [] });
});

test('a valid open hold accepts reordered steps and emits the exact overdue-held notice', () => {
  assert.deepEqual(withGroup(held, { items: hold() }), { violations: [], notices: [diagnostic(
    `overdue, held by OW-001: ${checklist} steps 4, 17б waited for 0.6.9`,
  )] });
});

test('a blocked hold accepts a binding on a continuation line and a longer work id', () => {
  const items = hold({ id: 'OW-1234', state: 'blocked', home: `Background\n  ${checklist} steps 4, 17б  ` });
  const result = withGroup({ ...held, work: 'OW-1234' }, { items });
  assert.deepEqual(result.violations, []);
  assert.match(result.notices[0].text, /held by OW-1234/);
});

test('unknown work item refuses the hold and leaves the group overdue', () => {
  const result = withGroup(held);
  fails(result, /OW-001: item does not exist/);
  assert.ok(result.violations.some((value) => value.text.startsWith('overdue:')));
  assert.deepEqual(result.notices, []);
});

for (const state of ['done', 'cancelled']) {
  test(`${state} item cannot hold steps`, () => {
    const result = withGroup(held, { items: hold({ state }) });
    fails(result, /state must be open or blocked/);
    assert.deepEqual(result.notices, []);
  });
}

for (const [name, home, pattern] of [
  ['subset', `${checklist} steps 4`, /has steps 4, expected 4, 17б/],
  ['superset', `${checklist} steps 4, 17б, 18`, /has steps 4, 17б, 18, expected 4, 17б/],
  ['duplicate binding steps', `${checklist} steps 4, 17б, 4`, /duplicate steps in binding/],
  ['different checklist', 'docs/checklists/Other.md steps 4, 17б', /exactly one binding/],
  ['split home lines', `${checklist} steps 4\n  ${checklist} steps 17б`, /has steps 4, expected 4, 17б/],
  ['split bare continuation', `${checklist} steps 4,\n  17б`, /exactly one binding/],
  ['prose containing steps', `${checklist}\n  Operator should run steps 4, 17б`, /exactly one binding/],
  ['embedded binding in prose', `Run ${checklist} steps 4, 17б`, /exactly one binding/],
  ['two exact binding lines', `${checklist} steps 4, 17б\n  ${checklist} steps 17б, 4`, /exactly one binding/],
]) {
  test(`hold refuses ${name}`, () => {
    const result = withGroup(held, { items: hold({ home }) });
    fails(result, pattern);
    assert.deepEqual(result.notices, []);
  });
}

test('a matching home does not hide a second binding with a different step set', () => {
  const result = withGroup(held, { items: hold({ home: `${checklist} steps 4, 17б\n  ${checklist} steps 4` }) });
  fails(result, /has steps 4, expected 4, 17б/);
  assert.deepEqual(result.notices, []);
});

test('steps in another register field cannot supply a missing home binding', () => {
  fails(withGroup(held, { items: hold({ home: 'A pending location',
    extra: `- следующий шаг: ${checklist} steps 4, 17б` }) }), /exactly one binding/);
});

test('home matching uses valueLines, never the joined field value', () => {
  const items = hold({ home: `${checklist} steps 4\n  ${checklist} steps 17б` });
  items[0].fields.find((field) => field.key === 'дом').value = `${checklist} steps 4, 17б`;
  fails(withGroup(held, { items }), /exactly one binding/);
});

for (const reason of ['', '   ']) {
  test(`none threshold refuses an empty blocker ${JSON.stringify(reason)}`, () => {
    const result = withGroup({ ...held, threshold: 'none' }, { items: hold({ reason }) });
    fails(result, /requires a non-empty blocker/);
    assert.deepEqual(result.notices, []);
  });
}

test('none threshold refuses a missing blocker field', () => {
  const items = hold();
  items[0].fields = items[0].fields.filter((field) => field.key !== 'блокер');
  fails(withGroup({ ...held, threshold: 'none' }, { items }), /requires a non-empty blocker/);
});

test('none threshold with a valid hold reports its blocker reason', () => {
  assert.deepEqual(withGroup({ ...held, threshold: 'none' }, { items: hold({ reason: '  Waiting for access  ' }) }),
    { violations: [], notices: [diagnostic(
      `no threshold, held by OW-001: ${checklist} steps 4, 17б: Waiting for access`,
    )] });
});

test('multiline blocker reason remains a one-line notice', () => {
  const result = withGroup({ ...held, threshold: 'none' }, { items: hold({ reason: 'Waiting\n  for access' }) });
  assert.deepEqual(result.violations, []);
  assert.equal(result.notices[0].text, `no threshold, held by OW-001: ${checklist} steps 4, 17б: Waiting for access`);
});

for (const version of ['0.6.8', '0.6.9']) {
  test(`work binding is validated before overdue at version ${version}`, () => {
    const result = withGroup(held, { version, items: hold({ home: `${checklist} steps 4` }) });
    fails(result, /has steps 4, expected 4, 17б/);
    assert.ok(result.violations.every((problem) => !problem.text.startsWith('overdue:')));
  });
  test(`a valid numeric hold preserves waiting/due behavior at version ${version}`, () => {
    const result = withGroup(held, { version, items: hold({ reason: '' }) });
    assert.deepEqual(result.violations, []);
    assert.equal(result.notices.length, version === '0.6.9' ? 1 : 0);
    if (result.notices.length) assert.match(result.notices[0].text, /^due:/);
  });
}

test('multiple groups are assessed independently and use the first markdown link', () => {
  const indexText = `## Актуальные\n- [First](Plan_72.md) [Other](Other.md) live=`
    + JSON.stringify([held, { steps: ['18'], threshold: '0.6.11' }]);
  const items = hold();
  const snapshot = structuredClone(items);
  const result = check({ indexText, items });
  assert.deepEqual(result.violations, []);
  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0].file, indexFile);
  assert.equal(result.notices[0].line, 2);
  assert.match(result.notices[0].text, /docs\/checklists\/Plan_72\.md/);
  assert.deepEqual(items, snapshot);
});
