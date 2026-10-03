import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskHeader, taskHeaderRefusal } from '../src/home/lib/task-header.mjs';

const advice = 'C:\\scratch\\advisor run';
const run = '2026-10-03_1_x';

function assertProblem(parsed, lineNo, line, reason) {
  const problem = parsed.problems.find((entry) => entry.lineNo === lineNo && entry.line === line);
  assert.ok(problem, `expected problem at line ${lineNo}: ${line}`);
  assert.match(problem.reason, reason);
}

test('advice and either grant parse in both header orders', () => {
  for (const kind of ['continue', 'retry']) {
    for (const header of [
      [`advice: ${advice}`, `${kind}: ${run} — why`],
      [`${kind}: ${run} — why`, `advice: ${advice}`],
    ]) {
      const parsed = parseTaskHeader([...header, '', 'Do the work.'].join('\n'));
      assert.deepEqual(parsed.fields, { advice, [kind]: `${run} — why` });
      assert.deepEqual(parsed.grant, { kind, run, reason: 'why' });
      assert.equal(parsed.advice, advice);
      assert.equal(parsed.body, '\nDo the work.');
      assert.deepEqual(parsed.problems, []);
      assert.equal(taskHeaderRefusal(parsed), null);
    }
  }
});

test('one initial BOM is removed and CRLF, CR and mixed endings are normalized', () => {
  for (const ending of ['\n', '\r\n', '\r']) {
    const parsed = parseTaskHeader(`\uFEFFadvice: mechanical${ending}continue:\tX - why\t ${ending}${ending}body${ending}`);
    assert.deepEqual(parsed.fields, { advice: 'mechanical', continue: 'X - why' });
    assert.deepEqual(parsed.grant, { kind: 'continue', run: 'X', reason: 'why' });
    assert.equal(parsed.body, '\nbody\n');
    assert.deepEqual(parsed.problems, []);
  }
  assert.equal(parseTaskHeader('\uFEFFtext\r\nnext\rlast\n').body, 'text\nnext\nlast\n');
  assert.equal(parseTaskHeader('\uFEFF\uFEFFtext').body, '\uFEFFtext');
});

test('a blank first line prevents a header and makes a later grant misplaced', () => {
  const line = `continue: ${run} — why`;
  const parsed = parseTaskHeader(`\n${line}\nbody`);
  assert.deepEqual(parsed.fields, {});
  assert.equal(parsed.grant, null);
  assert.equal(parsed.advice, null);
  assert.equal(parsed.body, `\n${line}\nbody`);
  assert.equal(parsed.problems.length, 1);
  assertProblem(parsed, 2, line, /misplaced continue/);
});

test('duplicate labels are refused even when their values are identical', () => {
  for (const label of ['advice', 'continue', 'retry']) {
    const first = label === 'advice' ? 'mechanical' : 'X — why';
    for (const second of [first, label === 'advice' ? 'docs-only' : 'Y — different']) {
      const line = `${label}: ${second}`;
      const parsed = parseTaskHeader(`${label}: ${first}\n${line}`);
      assert.equal(parsed.problems.length, 1);
      assertProblem(parsed, 2, line, new RegExp(`duplicate ${label}`));
      assert.equal(parsed.fields[label], first);
      if (label === 'advice') assert.equal(parsed.advice, first);
      else assert.deepEqual(parsed.grant, { kind: label, run: 'X', reason: 'why' });
    }
  }
});

test('a later duplicate cannot replace an invalid first field with valid authorization', () => {
  const parsed = parseTaskHeader('continue: TODO\ncontinue: X — why\nadvice: mechanical');
  assert.equal(parsed.fields.continue, 'TODO');
  assert.equal(parsed.grant, null);
  assert.equal(parsed.advice, 'mechanical');
  assert.equal(parsed.problems.length, 2);
  assertProblem(parsed, 1, 'continue: TODO', /bare run folder/);
  assertProblem(parsed, 2, 'continue: X — why', /duplicate continue/);
});

// Plan_75 D5: label presence must be checked before malformed values can hide a conflict.
test('continue and retry conflict in either order even if neither grant validates', () => {
  for (const values of [['X — why', 'Y: again'], ['TODO', '<run> — reason']]) {
    for (const order of [['continue', 'retry'], ['retry', 'continue']]) {
      const lines = order.map((label, index) => `${label}: ${values[index]}`);
      const parsed = parseTaskHeader(lines.join('\n'));
      const retryIndex = order.indexOf('retry');
      assertProblem(parsed, retryIndex + 1, lines[retryIndex], /cannot both be present/);
      assert.equal(parsed.problems.length, values[0] === 'TODO' ? 3 : 1);
      if (values[0] !== 'TODO') {
        assert.deepEqual(parsed.grant, { kind: order[0], run: 'X', reason: 'why' });
      } else {
        assert.equal(parsed.grant, null);
      }
    }
  }
});

test('grant validation rejects paths, dot folders, placeholders and missing reasons', () => {
  for (const kind of ['continue', 'retry']) {
    for (const value of ['a/b — why', 'a\\b — why', '.. — why', '. — why',
      '<run> — why', 'TODO — why', 'X — TODO', 'X — <reason>', 'X', 'X —', 'X Y — why']) {
      const line = `${kind}: ${value}`;
      const parsed = parseTaskHeader(`${line}\nadvice: mechanical\nbody`);
      assert.equal(parsed.grant, null, line);
      assert.equal(parsed.advice, 'mechanical');
      assert.equal(parsed.fields[kind], value);
      assert.equal(parsed.problems.length, 1);
      assertProblem(parsed, 1, line, /bare run folder/);
    }
  }
  for (const separator of [' — ', ' - ', ':', '\t—\t']) {
    assert.deepEqual(parseTaskHeader(`retry: A.b_1-2${separator}why`).grant, {
      kind: 'retry', run: 'A.b_1-2', reason: 'why',
    });
  }
});

test('empty advice is refused without extending the non-empty header grammar', () => {
  for (const line of ['advice:', 'advice: \t ']) {
    const parsed = parseTaskHeader(`${line}\nbody`);
    assert.deepEqual(parsed.fields, {});
    assert.equal(parsed.advice, null);
    assert.equal(parsed.body, `${line}\nbody`);
    assert.equal(parsed.problems.length, 1);
    assertProblem(parsed, 1, line, /advice value must be non-empty/);
  }
  const parsed = parseTaskHeader('continue: X — why\nadvice:\nadvice: docs-only');
  assert.deepEqual(parsed.grant, { kind: 'continue', run: 'X', reason: 'why' });
  assert.equal(parsed.advice, null);
  assert.equal(parsed.problems.length, 2);
  assertProblem(parsed, 3, 'advice: docs-only', /misplaced advice/);
});

test('advice header values require no authorization or path validation here', () => {
  for (const value of ['mechanical', 'revert', 'docs-only', 'test-only', 'arbitrary words',
    '/tmp/advisor run', 'C:\\scratch\\advisor run', '<not checked here>']) {
    const parsed = parseTaskHeader(`advice: ${value}`);
    assert.equal(parsed.advice, value);
    assert.deepEqual(parsed.problems, []);
  }
});

test('the first non-header line closes the header for good', () => {
  for (const terminator of ['', 'Do the work.', 'unknown: value']) {
    const line = 'retry: X — y';
    const parsed = parseTaskHeader(`advice: mechanical\n${terminator}\n${line}`);
    assert.deepEqual(parsed.fields, { advice: 'mechanical' });
    assert.equal(parsed.advice, 'mechanical');
    assert.equal(parsed.grant, null);
    assert.equal(parsed.body, `${terminator}\n${line}`);
    assert.equal(parsed.problems.length, 1);
    assertProblem(parsed, 3, line, /misplaced retry/);
  }
});

test('decorated or uppercase spellings are misplaced even at physical line one', () => {
  const cases = [
    ['- continue: X — y', 'continue'],
    ['**retry:** X', 'retry'],
    ['Advice: mechanical', 'advice'],
    ['  * continue = X: why', 'continue'],
    ['*retry*: X', 'retry'],
    ['_continue_: X - y', 'continue'],
    ['`retry`=S', 'retry'],
    ['continue = X — y', 'continue'],
    ['\tcontinue: X — y', 'continue'],
  ];
  for (const [line, label] of cases) {
    for (const prefix of ['', 'advice: docs-only\nbody\n']) {
      const parsed = parseTaskHeader(prefix + line);
      const lineNo = prefix ? 3 : 1;
      assert.equal(parsed.problems.length, 1, line);
      assertProblem(parsed, lineNo, line, new RegExp(`misplaced ${label}`));
      assert.match(parsed.problems[0].reason, new RegExp(`spelled ${label}: <value>`));
      assert.match(parsed.problems[0].reason, /quote it with > or reword it inside a sentence/);
    }
  }
});

test('misplaced guard checks the grant shape rather than interpreting ordinary prose', () => {
  const lines = ['continue: 2026-10-03_1_x — why', 'retry: S',
    'continue: X - reason', 'retry: X:reason', 'retry: ..'];
  const parsed = parseTaskHeader(['body', ...lines].join('\n'));
  assert.equal(parsed.problems.length, lines.length);
  for (const [index, line] of lines.entries()) {
    assertProblem(parsed, index + 2, line, /misplaced/);
  }
});

test('advice shapes below the header include tokens and absolute paths with spaces', () => {
  for (const value of ['mechanical', 'revert', 'docs-only', 'test-only', 'some-token',
    '/tmp/advice folder', 'C:\\scratch\\advice folder', '\\\\server\\share\\advice folder']) {
    const line = `advice: ${value}`;
    const parsed = parseTaskHeader(`body\n${line}`);
    assert.equal(parsed.problems.length, 1, value);
    assertProblem(parsed, 2, line, /misplaced advice/);
  }
});

// 2026-10-03 20:42: wrapping prose at a grant label must not create authorization.
test('prose beginning with each label and quoted examples remain body text', () => {
  const body = [
    'Do the work.',
    'continue: the remaining work needs discussion',
    'continue: A` under order',
    'continue: `X` — quoted token',
    'retry: *X* — quoted token',
    'retry: the failed work needs discussion',
    'advice: the next step needs discussion',
    'continue: X without a reason separator',
    '> continue: X — why',
    '> advice: mechanical',
    'The example is retry: X — y inside a sentence.',
  ].join('\n');
  const parsed = parseTaskHeader(body);
  assert.equal(parsed.body, body);
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.grant, null);
  assert.equal(parsed.advice, null);
});

test('a fenced grant example is still misplaced and keeps its physical line number', () => {
  const line = 'retry: X — y';
  const parsed = parseTaskHeader(`advice: mechanical\n\n\x60\x60\x60text\n${line}\n\x60\x60\x60`);
  assert.equal(parsed.problems.length, 1);
  assertProblem(parsed, 4, line, /misplaced retry/);
});

test('body preserves whitespace, trailing empty lines and Unicode apart from line endings', () => {
  const body = '\n  Text with spaces.  \n\tTabbed text\nUnicode: Ω — café\n\n';
  assert.equal(parseTaskHeader(`advice: mechanical\ncontinue: X — why\n${body}`).body, body);
  assert.equal(parseTaskHeader(`advice: mechanical\r\n${body.replaceAll('\n', '\r\n')}`).body, body);
  assert.equal(parseTaskHeader('advice: mechanical').body, '');
  assert.equal(parseTaskHeader('advice: mechanical\n').body, '');
});

test('a headerless document returns empty metadata without problems', () => {
  for (const body of ['', 'Do the work.', '\nOrdinary task\n']) {
    assert.deepEqual(parseTaskHeader(body), {
      fields: {}, grant: null, advice: null, body, problems: [],
    });
    assert.equal(taskHeaderRefusal(parseTaskHeader(body)), null);
  }
});

test('refusal reports every problem with original lines and the no-quota statement', () => {
  const parsed = parseTaskHeader('continue: X — why\ncontinue: Y — again\nbody\n**retry:** X');
  assert.equal(parsed.problems.length, 2);
  assert.deepEqual(parsed.grant, { kind: 'continue', run: 'X', reason: 'why' });
  assert.equal(taskHeaderRefusal(parsed), parsed.problems
    .map(({ lineNo, line, reason }) => `line ${lineNo}: ${reason}: ${line}`)
    .join('\n') + '\nThe run folder was not created; quota was not spent.');
});
