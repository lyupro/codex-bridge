/** OW-068 / Plan_80 E21: judged agents produce failure reasons through the prompt's catalog. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ANSWER_RULES } from '../src/home/lib/answer-rules.mjs';

const judgedAgents = [
  {
    agent: 'codex-advisor',
    files: [{ file: 'advice-verdict.mjs' }],
    check: producerProblems,
  },
  {
    agent: 'codex-scout',
    files: [
      { file: 'verdict.mjs', functionName: 'scoutCoverageGap' },
      { file: 'context-only.mjs', functionName: 'contextOnlyGap' },
      { file: 'execution-fact.mjs', functionName: 'scoutExecutionGap' },
    ],
    check: scoutProducerProblems,
  },
  {
    agent: 'codex-build',
    files: [
      { file: 'verdict.mjs', functionNames: ['commitDuringRun', 'branchDuringRun', 'reportVersusWork'] },
      { file: 'outcome.mjs', functionNames: ['outcomeGap'] },
    ],
    check: buildProducerProblems,
  },
].map((judge) => ({
  ...judge,
  catalogKeys: Object.keys(ANSWER_RULES[judge.agent]),
  files: judge.files.map((entry) => ({
    ...entry,
    source: fs.readFileSync(new URL(`../src/home/lib/meta/${entry.file}`, import.meta.url), 'utf8'),
  })),
}));
const [advisor, scout, build] = judgedAgents;
const source = advisor.files[0].source;
const catalogKeys = advisor.catalogKeys;

// OW-068 / Plan_80 E21: future failure branches must use the same catalog as the prompt.
function producerProblems(source, catalogKeys) {
  const problems = [];
  const known = new Set(catalogKeys);
  const produced = new Set();
  for (const match of source.matchAll(/\breason\s*\(\s*(['"])([^'"]+)\1|\bkey\s*:\s*(['"])([^'"]+)\3/g)) {
    const key = match[2] ?? match[4];
    if (!known.has(key)) problems.push(`unknown catalog key: ${key}`);
    produced.add(key);
  }
  for (const key of known) {
    if (!produced.has(key)) problems.push(`missing producer: ${key}`);
  }

  for (const match of source.matchAll(/\breasons\s*\.\s*push\s*\(/g)) {
    const args = [];
    let start = match.index + match[0].length;
    let depth = 0;
    let quote = null;
    let closed = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') quote = char;
      else if ('([{'.includes(char)) depth += 1;
      else if (char === ')' && depth === 0) {
        args.push(source.slice(start, index).trim());
        closed = true;
        break;
      } else if (')]}'.includes(char)) depth -= 1;
      else if (char === ',' && depth === 0) {
        args.push(source.slice(start, index).trim());
        start = index + 1;
      }
    }
    if (!closed) problems.push('unclosed reasons.push');
    for (const arg of args) {
      // The citation dispatcher is the sole dynamic key: citationProblem returns catalog literals.
      const citationDispatch = /^reason\(problem\.key,\s*\{\s*field,\s*label,\s*\.\.\.problem\.values\s*\}\s*\)$/;
      if (!/^reason\('[^']+'(?=\s*[,\)])/.test(arg) && !citationDispatch.test(arg)) {
        problems.push(`reasons.push bypasses catalog: ${arg}`);
      }
    }
  }
  if (/['"`](?:D3|D4|D5|D10|integrity) /.test(source)) problems.push('handwritten failure reason');
  const returns = [...source.matchAll(/\breturn\s*\{\s*ok\s*:/g)].length;
  if (returns !== 1) problems.push(`expected one verdict return, found ${returns}`);
  return problems;
}

// E21: inspect only the named judge, ignoring braces/returns in literals, comments and callbacks.
function tokensOf(source) {
  const tokens = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\r\n\\])+\/[a-z]*|[A-Za-z_$][\w$]*|=>|[^\s]/g;
  return [...source.matchAll(tokens)]
    .filter(([token]) => !token.startsWith('//') && !token.startsWith('/*'))
    .map(([token]) => token);
}

function closingToken(tokens, start) {
  const close = { '(': ')', '[': ']', '{': '}' }[tokens[start]];
  let depth = 1;
  for (let index = start + 1; index < tokens.length; index += 1) {
    if (tokens[index] === tokens[start]) depth += 1;
    if (tokens[index] === close && --depth === 0) return index;
  }
  throw new Error(`unclosed token: ${tokens[start]}`);
}

function functionBody(tokens, name) {
  const start = tokens.findIndex((token, index) => token === 'function' && tokens[index + 1] === name);
  if (start < 0) throw new Error(`missing judge function: ${name}`);
  const bodyStart = closingToken(tokens, start + 2) + 1;
  assert.equal(tokens[bodyStart], '{');
  return tokens.slice(bodyStart + 1, closingToken(tokens, bodyStart));
}

function scoutProducerProblems(files, catalogKeys) {
  const problems = [];
  const known = new Set(catalogKeys);
  const produced = new Set();
  const opening = /^['"`](?:scout did not answer|response to |responses without|response without analysis|responses to startup-context|scout cited|scout executed no command)/;
  for (const { source, functionName } of files) {
    const tokens = tokensOf(source);
    if (tokens.some((token) => opening.test(token))) problems.push('handwritten scout failure reason');
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== 'scoutReason' || tokens[index + 1] !== '(') continue;
      const key = /^(['"])([^'"\\]+)\1$/.exec(tokens[index + 2] ?? '')?.[2];
      if (key && !known.has(key)) problems.push(`unknown catalog key: ${key}`);
    }
    const body = functionBody(tokens, functionName);
    for (let index = 0; index < body.length; index += 1) {
      if (body[index] === '=>' && body[index + 1] === '{') {
        index = closingToken(body, index + 1);
        continue;
      }
      if (body[index] !== 'return') continue;
      const start = index + 1;
      let end = start;
      while (end < body.length && body[end] !== ';' && body[end] !== '}') {
        if (['(', '[', '{'].includes(body[end])) end = closingToken(body, end);
        end += 1;
      }
      const expression = body.slice(start, end);
      if (expression.join(' ') === 'null' || expression.join(' ') === 'execution . gap') continue;
      const key = /^(['"])([^'"\\]+)\1$/.exec(expression[2] ?? '')?.[2];
      if (expression[0] !== 'scoutReason' || expression[1] !== '(' || !key
        || ![',', ')'].includes(expression[3]) || closingToken(expression, 1) !== expression.length - 1) {
        problems.push(`scout return bypasses catalog: ${expression.join(' ')}`);
        continue;
      }
      produced.add(key);
    }
  }
  for (const key of known) {
    if (!produced.has(key)) problems.push(`missing producer: ${key}`);
  }
  return problems;
}

// E21: build-only reasons are catalog policy; snapshot refusals remain host evidence.
function buildProducerProblems(files, catalogKeys) {
  const problems = [];
  const known = new Set(catalogKeys);
  const produced = new Set();
  const opening = /^['"`](?:commit made despite|branch moved despite|verification “|the task was not done|result is not filled in|result declares an unknown outcome|out-of-scope changes|wrong work was done|run did not change the tree)/;
  const emitterCall = (expression) => expression[0] === 'buildReason' && expression[1] === '('
    && /^(['"])([^'"\\]+)\1$/.test(expression[2] ?? '') && [',', ')'].includes(expression[3])
    && closingToken(expression, 1) === expression.length - 1;
  for (const { source, functionNames } of files) {
    const tokens = tokensOf(source);
    if (tokens.some((token) => opening.test(token))) problems.push('handwritten build failure reason');
    // Include inline resolveStatus reasons, not just the four named producer functions.
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index] !== 'buildReason' || tokens[index + 1] !== '(') continue;
      const key = /^(['"])([^'"\\]+)\1$/.exec(tokens[index + 2] ?? '')?.[2];
      if (!key || ![',', ')'].includes(tokens[index + 3])) problems.push('build emitter requires a literal key');
      else {
        if (!known.has(key)) problems.push(`unknown catalog key: ${key}`);
        produced.add(key);
      }
    }
    for (const name of functionNames) {
      const body = functionBody(tokens, name);
      for (let index = 0; index < body.length; index += 1) {
        if (body[index] === '=>' && body[index + 1] === '{') {
          index = closingToken(body, index + 1);
          continue;
        }
        if (body[index] !== 'return') continue;
        const start = index + 1;
        let end = start;
        while (end < body.length && body[end] !== ';' && body[end] !== '}') {
          if (['(', '[', '{'].includes(body[end])) end = closingToken(body, end);
          end += 1;
        }
        const expression = body.slice(start, end);
        const text = expression.join(' ');
        if (['null', 'agreed ( )', 'agreed ( true )', 'snapshotRefusal ( comparison )',
          'broken ( snapshotRefusal ( comparison ) )'].includes(text) || emitterCall(expression)) continue;
        if (['broken', 'agreed'].includes(expression[0]) && expression[1] === '('
          && closingToken(expression, 1) === expression.length - 1
          && emitterCall(expression.slice(2, -1))) continue;
        problems.push(`build return bypasses catalog: ${text}`);
      }
    }
  }
  for (const key of known) {
    if (!produced.has(key)) problems.push(`missing producer: ${key}`);
  }
  return problems;
}

function mutated(before, after) {
  assert.ok(source.includes(before), `mutation anchor missing: ${before}`);
  return source.replace(before, after);
}

for (const judge of judgedAgents) {
  test(`${judge.agent.replace('codex-', '')} judge produces every catalog rule and every reason goes through the catalog`, () => {
    const input = judge === advisor ? judge.files[0].source : judge.files;
    assert.deepEqual(judge.check(input, judge.catalogKeys), []);
  });
}

test('producer guard rejects unknown literal emitter and citation keys', () => {
  for (const key of ['advisor-commands-run', 'advisor-citation-path']) {
    const edited = mutated(`'${key}'`, "'advisor-unknown'");
    assert.ok(producerProblems(edited, catalogKeys).includes('unknown catalog key: advisor-unknown'));
  }
});

test('producer guard rejects a handwritten reason added to the real judge', () => {
  const edited = mutated('const reasons = [];', 'const reasons = []; reasons.push(`D5 x`);');
  const problems = producerProblems(edited, catalogKeys);
  assert.ok(problems.some((problem) => problem.startsWith('reasons.push bypasses catalog:')));
  assert.ok(problems.includes('handwritten failure reason'));
});

test('producer guard checks every push argument and disallows arbitrary dynamic keys', () => {
  for (const extra of ["'unlisted failure'", 'reason(other.key, {})']) {
    const edited = mutated("reason('advisor-commands-run'))", `reason('advisor-commands-run'), ${extra})`);
    assert.ok(producerProblems(edited, catalogKeys).some((problem) => problem.startsWith('reasons.push bypasses catalog:')));
  }
});

test('producer guard rejects a second verdict return', () => {
  const edited = mutated('const reasons = [];', 'const reasons = []; return { ok: false, reasons };');
  assert.ok(producerProblems(edited, catalogKeys).includes('expected one verdict return, found 2'));
});

test('producer guard rejects a catalog rule removed from the judge', () => {
  const edited = mutated("reasons.push(reason('advisor-commands-run'));", ';');
  assert.ok(producerProblems(edited, catalogKeys).includes('missing producer: advisor-commands-run'));
});

function mutatedScout(file, before, after) {
  const entry = scout.files.find((entry) => entry.file === file);
  assert.ok(entry.source.includes(before), `mutation anchor missing: ${before}`);
  return scout.files.map((entry) => entry.file === file
    ? { ...entry, source: entry.source.replace(before, after) } : entry);
}

test('scout producer guard rejects an unknown literal emitter key', () => {
  const edited = mutatedScout('execution-fact.mjs', "'scout-commands-run'", "'scout-unknown'");
  assert.ok(scout.check(edited, scout.catalogKeys).includes('unknown catalog key: scout-unknown'));
});

test('scout producer guard checks literal keys and handwritten openings outside judge functions', () => {
  for (const [extra, problem] of [
    ["scoutReason('scout-unknown');", 'unknown catalog key: scout-unknown'],
    ['const handwritten = `scout cited x`;', 'handwritten scout failure reason'],
  ]) {
    const edited = mutatedScout('context-only.mjs', 'export function allStartupContext(questions) {',
      `${extra}\nexport function allStartupContext(questions) {`);
    assert.ok(scout.check(edited, scout.catalogKeys).includes(problem));
  }
});

test('scout producer guard rejects a handwritten coordinate reason in contextOnlyGap', () => {
  const edited = mutatedScout('context-only.mjs',
    'export function contextOnlyGap({ questions, result, commandsExecuted }) {',
    'export function contextOnlyGap({ questions, result, commandsExecuted }) { return `scout cited x`;');
  const problems = scout.check(edited, scout.catalogKeys);
  assert.ok(problems.includes('handwritten scout failure reason'));
  assert.ok(problems.some((problem) => problem.startsWith('scout return bypasses catalog:')));
});

test('scout producer guard rejects a catalog rule removed from the judges', () => {
  const edited = mutatedScout('execution-fact.mjs', "return scoutReason('scout-commands-run');", 'return null;');
  assert.ok(scout.check(edited, scout.catalogKeys).includes('missing producer: scout-commands-run'));
});

test('scout producer guard rejects a bare string in scoutCoverageGap', () => {
  const edited = mutatedScout('verdict.mjs', 'function scoutCoverageGap(orderedQuestions, result) {',
    "function scoutCoverageGap(orderedQuestions, result) { return 'thin';");
  assert.ok(scout.check(edited, scout.catalogKeys).some((problem) => problem.startsWith('scout return bypasses catalog:')));
});

function mutatedBuild(file, before, after) {
  const entry = build.files.find((entry) => entry.file === file);
  assert.ok(entry.source.includes(before), `mutation anchor missing: ${before}`);
  return build.files.map((entry) => entry.file === file
    ? { ...entry, source: entry.source.replace(before, after) } : entry);
}

test('build producer guard rejects unknown literal keys in either judge file', () => {
  for (const [file, key] of [['verdict.mjs', 'build-commit'], ['outcome.mjs', 'build-outcome-fail']]) {
    const edited = mutatedBuild(file, `'${key}'`, "'build-unknown'");
    assert.ok(build.check(edited, build.catalogKeys).includes('unknown catalog key: build-unknown'));
  }
});

test('build producer guard rejects handwritten and arbitrary returns in every producer', () => {
  for (const { file, functionNames } of build.files) {
    for (const name of functionNames) {
      for (const reason of ['`commit made despite prohibition: x`', "'unlisted failure'"]) {
        const entry = build.files.find((entry) => entry.file === file);
        const signature = entry.source.match(new RegExp(`function ${name}\\([^)]*\\) \\{`))?.[0];
        assert.ok(signature, `mutation signature missing: ${name}`);
        const edited = mutatedBuild(file, signature, `${signature} return ${reason};`);
        const problems = build.check(edited, build.catalogKeys);
        assert.ok(problems.some((problem) => problem.startsWith('build return bypasses catalog:')));
        if (reason.startsWith('`')) assert.ok(problems.includes('handwritten build failure reason'));
      }
    }
  }
});

test('build producer guard rejects removed catalog producers, including inline reasons', () => {
  for (const key of build.catalogKeys) {
    const { file } = build.files.find((entry) => entry.source.includes(`'${key}'`));
    const replacement = key === 'build-commit' ? 'build-branch-moved' : 'build-commit';
    const edited = mutatedBuild(file, `'${key}'`, `'${replacement}'`);
    assert.ok(build.check(edited, build.catalogKeys).includes(`missing producer: ${key}`));
  }
});

test('build producer guard checks keys and handwritten openings outside producer functions', () => {
  for (const file of ['verdict.mjs', 'outcome.mjs']) {
    for (const [extra, problem] of [
      ["buildReason('build-unknown');", 'unknown catalog key: build-unknown'],
      ['buildReason(other.key);', 'build emitter requires a literal key'],
      ["buildReason('build-commit' + suffix);", 'build emitter requires a literal key'],
      ['const handwritten = `out-of-scope changes (1): x`;', 'handwritten build failure reason'],
    ]) {
      const edited = mutatedBuild(file, 'import path from', `${extra}\nimport path from`);
      assert.ok(build.check(edited, build.catalogKeys).includes(problem));
    }
  }
});

test('build producer guard rejects every current reason opening in either file', () => {
  const openings = ['commit made despite', 'branch moved despite', 'verification “', 'the task was not done',
    'result is not filled in', 'result declares an unknown outcome', 'out-of-scope changes',
    'wrong work was done', 'run did not change the tree'];
  for (const file of ['verdict.mjs', 'outcome.mjs']) {
    for (const opening of openings) {
      for (const quote of ["'", '"', '`']) {
        const edited = mutatedBuild(file, 'import path from', `const handwritten = ${quote}${opening} x${quote};\nimport path from`);
        assert.ok(build.check(edited, build.catalogKeys).includes('handwritten build failure reason'));
      }
    }
  }
});
