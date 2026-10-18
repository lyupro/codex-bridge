/** OW-068 / Plan_80 E21: agent branches must obtain model-facing failure reasons from catalog judges. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ANSWER_RULES } from '../src/home/lib/answer-rules.mjs';
import { JUDGED_AGENTS, HOST_REASON_FUNCTIONS, HOST_REASON_SUFFIXES } from './answer-rules-judges.mjs';
import { tokensOf, closingToken, functionBody } from './source-tokens.mjs';

const source = fs.readFileSync(new URL('../src/home/lib/meta/verdict.mjs', import.meta.url), 'utf8');
const literal = (token) => /^(['"])([^'"\\]*)\1$/.exec(token ?? '')?.[2];
const identifier = (token) => /^[A-Za-z_$][\w$]*$/.test(token ?? '');

function statementEnd(tokens, start) {
  if (tokens[start] === '{') return closingToken(tokens, start);
  if (tokens[start] === 'if') {
    const end = statementEnd(tokens, closingToken(tokens, start + 1) + 1);
    return tokens[end + 1] === 'else' ? statementEnd(tokens, end + 2) : end;
  }
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index] === ';') return index;
    if (['(', '[', '{'].includes(tokens[index])) index = closingToken(tokens, index);
  }
  return tokens.length - 1;
}

function splitExpressions(tokens) {
  const expressions = [];
  let start = 0;
  for (let index = 0; index <= tokens.length; index += 1) {
    if (index === tokens.length || tokens[index] === ',') {
      expressions.push(tokens.slice(start, index));
      start = index + 1;
    } else if (['(', '[', '{'].includes(tokens[index])) index = closingToken(tokens, index);
  }
  return expressions;
}

function judgeInitializer(expression, entries) {
  let index = 0;
  let calls = 0;
  while (index < expression.length) {
    calls += 1;
    if (calls > 2) return false;
    if (!entries.includes(expression[index]) || expression[index + 1] !== '(') return false;
    index = closingToken(expression, index + 1) + 1;
    if (index === expression.length) return true;
    if (expression[index] !== '?' || expression[index + 1] !== '?') return false;
    index += 2;
    if (index === expression.length) return false;
  }
  return false;
}

function catalogReason(expression, bindings, judge) {
  const bound = (value) => bindings.has(value[0]) && (value.length === 1
    || (value.length === 3 && value[1] === '.' && value[2] === 'reason'));
  if (bound(expression)) return true;
  if (expression.length >= 3 && expression[1] === '('
    && closingToken(expression, 1) === expression.length - 1) {
    if (Object.hasOwn(HOST_REASON_FUNCTIONS, expression[0])) return true;
    return expression[0] === judge?.emitter && literal(expression[2]) !== undefined
      && [',', ')'].includes(expression[3]);
  }
  if (expression.length !== 1 || !expression[0].startsWith('`')) return false;
  let remaining = expression[0].slice(1, -1);
  let count = 0;
  while (remaining) {
    const match = /^\$\{([^{}]*)\}/.exec(remaining);
    if (!match) return false;
    const value = tokensOf(match[1]);
    if (count === 0 ? !bound(value) : value.length !== 1 || !Object.hasOwn(HOST_REASON_SUFFIXES, value[0])) return false;
    count += 1;
    remaining = remaining.slice(match[0].length);
  }
  return count > 0;
}

// Plan_80 E21: host transport failures stay outside this agent-only boundary.
function branchProblems(verdictSource, table, rules) {
  const body = functionBody(tokensOf(verdictSource), 'resolveStatus');
  const problems = [];
  const branches = [];
  const literalUses = new Set();
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== 'if' || body[index + 1] !== '(') continue;
    const conditionEnd = closingToken(body, index + 1);
    const agents = [];
    for (let cursor = index + 2; cursor < conditionEnd; cursor += 1) {
      if (body[cursor] !== 'agent' || body.slice(cursor + 1, cursor + 4).join('') !== '===') continue;
      const agent = literal(body[cursor + 4]);
      if (agent === undefined) continue;
      literalUses.add(cursor);
      agents.push(agent);
    }
    if (!agents.length) continue;
    const start = conditionEnd + 1;
    const end = statementEnd(body, start);
    if (body[end + 1] === 'else') problems.push('agent used outside a literal branch: else after agent branch');
    for (const agent of agents) branches.push({ agent, start, end });
  }
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === 'agent' && !literalUses.has(index)) problems.push('agent used outside a literal branch');
    if (body[index].startsWith('`') && [...body[index].matchAll(/\$\{([^{}]*)\}/g)]
      .some((match) => tokensOf(match[1]).includes('agent'))) problems.push('agent used outside a literal branch');
  }
  const calls = new Map(table.map(({ agent }) => [agent, new Set()]));
  for (const { agent, start, end } of branches) {
    const judge = table.find((row) => row.agent === agent);
    if (!Object.hasOwn(rules, agent)) problems.push(`agent branch without answer rules: ${agent}`);
    if (!judge) problems.push(`agent branch without judge row: ${agent}`);
    const bindings = new Map();
    const scopes = [];
    for (let index = start; index <= end; index += 1) {
      if (body[index] === '{') scopes.push(new Map(bindings));
      if (body[index] === '}') {
        const previous = scopes.pop();
        if (previous) { bindings.clear(); for (const [name, valid] of previous) bindings.set(name, valid); }
      }
      const name = body[index];
      if (body[index + 1] === '(' && body[index - 1] !== '.') {
        if (judge?.entries.includes(name)) calls.get(agent).add(name);
        if (table.some((row) => row.agent !== agent && row.entries.includes(name))) {
          problems.push(`branch uses another agent's judge: ${agent}: ${name}`);
        }
      }
      if (name === 'const' && identifier(body[index + 1]) && body[index + 2] === '=') {
        const declarationEnd = statementEnd(body, index);
        for (const declaration of splitExpressions(body.slice(index + 1, declarationEnd))) {
          if (declaration[1] !== '=') continue;
          bindings.delete(declaration[0]);
          if (judgeInitializer(declaration.slice(2), judge?.entries ?? [])) bindings.set(declaration[0], true);
        }
      }
      if (name !== 'return' || body[index + 1] !== '{') continue;
      const objectEnd = closingToken(body, index + 1);
      const fields = splitExpressions(body.slice(index + 2, objectEnd));
      const status = fields.find((field) => field[0] === 'status' && field[1] === ':')?.slice(2);
      if (!status || (status.length === 1 && literal(status[0]) === 'OK')) continue;
      const reason = fields.find((field) => field[0] === 'reason' && field[1] === ':')?.slice(2) ?? [];
      if (!catalogReason(reason, bindings, judge)) problems.push(`branch reason bypasses catalog: ${agent}: ${reason.join(' ')}`);
    }
  }
  for (const { agent, entries } of table) {
    for (const entry of entries) {
      if (!calls.get(agent).has(entry)) problems.push(`judge entry not called: ${agent}: ${entry}`);
    }
  }
  for (const agent of Object.keys(rules)) {
    if (!branches.some((branch) => branch.agent === agent)) problems.push(`judged agent without branch: ${agent}`);
  }
  return problems;
}

function mutated(anchor, replacement) {
  assert.ok(source.includes(anchor), `mutation anchor missing: ${anchor}`);
  return source.replace(anchor, replacement);
}

const problemsOf = (edited) => branchProblems(edited, JUDGED_AGENTS, ANSWER_RULES);
const scoutBranch = "if (agent === 'codex-scout') {";
const advisorCondition = "agent === 'codex-advisor'";

test('resolveStatus agent branches obtain every failure reason through registered judges', () => {
  assert.deepEqual(problemsOf(source), []);
});

test('branch guard rejects a new agent without catalog or judge rows', () => {
  const edited = mutated(scoutBranch, "if (agent === 'codex-review') { return { status: 'FAIL', reason: 'x' }; }\n" + scoutBranch);
  const problems = problemsOf(edited);
  assert.ok(problems.includes('agent branch without answer rules: codex-review'));
  assert.ok(problems.includes('agent branch without judge row: codex-review'));
});

test('branch guard rejects a handwritten scout template reason', () => {
  const edited = mutated(scoutBranch, scoutBranch + " return { status: 'FAIL', reason: `handwritten ${runDir}` };");
  assert.ok(problemsOf(edited).includes('branch reason bypasses catalog: codex-scout: `handwritten ${runDir}`'));
});

test('branch guard rejects an unregistered function bound to a scout reason', () => {
  const edited = mutated(scoutBranch, scoutBranch + " const unknown = foo(runDir); if (unknown) return { status: 'FAIL', reason: unknown };");
  assert.ok(problemsOf(edited).includes('branch reason bypasses catalog: codex-scout: unknown'));
});

test('branch guard rejects another agent judge bound to a scout reason', () => {
  const edited = mutated(scoutBranch, scoutBranch + " const wrong = commitDuringRun(runDir); if (wrong) return { status: 'FAIL', reason: wrong };");
  assert.ok(problemsOf(edited).includes("branch uses another agent's judge: codex-scout: commitDuringRun"));
  assert.ok(problemsOf(edited).includes('branch reason bypasses catalog: codex-scout: wrong'));
});

test('branch guard rejects nonliteral agent dispatch and notices its missing branch', () => {
  const problems = problemsOf(mutated(advisorCondition, "agent.endsWith('advisor')"));
  assert.ok(problems.includes('agent used outside a literal branch'));
  assert.ok(problems.includes('judged agent without branch: codex-advisor'));
});

test('branch guard rejects an advisor entry removed from its branch', () => {
  const edited = mutated('const gap = adviceGap(runDir, result, eventData, execution);', 'const gap = null;');
  assert.ok(problemsOf(edited).includes('judge entry not called: codex-advisor: adviceGap'));
});

test('branch guard allows only the named host refusal function', () => {
  const edited = mutated('reason: snapshotRefusal(comparison)', 'reason: otherRefusal(comparison)');
  assert.ok(problemsOf(edited).includes('branch reason bypasses catalog: codex-build: otherRefusal ( comparison )'));
});

test('branch guard allows only the named host template suffix', () => {
  const edited = mutated('${verdict.reason}${hooks}', '${verdict.reason}${extra}');
  assert.ok(problemsOf(edited).includes('branch reason bypasses catalog: codex-build: `${verdict.reason}${extra}`'));
});

test('branch guard rejects else dispatch after a block or a single-statement agent branch', () => {
  for (const branch of [scoutBranch + '}', "if (agent === 'codex-scout') return { status: 'OK', reason: null };"]) {
    const edited = mutated(scoutBranch, branch + ' else { return { status: \'FAIL\', reason: \'x\' }; }\n' + scoutBranch);
    assert.ok(problemsOf(edited).some((problem) => problem.startsWith('agent used outside a literal branch')));
  }
});

test('branch guard rejects agent uses outside literal conditions, including template interpolations', () => {
  for (const extra of ['const other = agent;', 'if (agent === other) {}', 'const text = `${agent}`;']) {
    assert.ok(problemsOf(mutated(scoutBranch, scoutBranch + extra)).includes('agent used outside a literal branch'));
  }
});

test('branch guard checks catalog and judge table membership independently', () => {
  const { 'codex-scout': omitted, ...rules } = ANSWER_RULES;
  assert.ok(branchProblems(source, JUDGED_AGENTS, rules).includes('agent branch without answer rules: codex-scout'));
  const table = JUDGED_AGENTS.filter(({ agent }) => agent !== 'codex-scout');
  assert.ok(branchProblems(source, table, ANSWER_RULES).includes('agent branch without judge row: codex-scout'));
  assert.ok(branchProblems(source, JUDGED_AGENTS, { ...ANSWER_RULES, 'codex-review': {} })
    .includes('judged agent without branch: codex-review'));
});

test('branch guard accepts only registered bindings, their reason property and interpolation-only templates', () => {
  for (const reason of ['accepted', 'accepted.reason', '`${accepted}`', '`${accepted.reason}${hooks}`']) {
    const extra = ` const accepted = scoutExecutionGap({ execution }) ?? scoutCoverageGap([], result);\n`
      + `if (accepted) return { status: 'FAIL', reason: ${reason} };`;
    assert.deepEqual(problemsOf(mutated(scoutBranch, scoutBranch + extra)), []);
  }
});

test('branch guard rejects unregistered coalescing calls and non-call binding expressions', () => {
  for (const initializer of ['foo(runDir) ?? scoutCoverageGap([], result)',
    'scoutCoverageGap([], result) ?? foo(runDir)', 'scoutCoverageGap([], result) || scoutExecutionGap({ execution })',
    "'handwritten'", 'scoutCoverageGap([], result) + suffix']) {
    const extra = ` const rejected = ${initializer}; if (rejected) return { status: 'FAIL', reason: rejected };`;
    assert.ok(problemsOf(mutated(scoutBranch, scoutBranch + extra))
      .includes('branch reason bypasses catalog: codex-scout: rejected'));
  }
});

test('branch guard rejects unbound, later and out-of-scope reason identifiers', () => {
  for (const extra of ["return { status: 'FAIL', reason: gap };",
    "return { status: 'FAIL', reason: later }; const later = scoutCoverageGap([], result);",
    "{ const hidden = scoutCoverageGap([], result); } return { status: 'FAIL', reason: hidden };"]) {
    assert.ok(problemsOf(mutated(scoutBranch, scoutBranch + extra))
      .some((problem) => problem.startsWith('branch reason bypasses catalog: codex-scout:')));
  }
});

test('branch guard accepts literal inline emitters and rejects dynamic keys or another emitter', () => {
  assert.deepEqual(problemsOf(mutated(scoutBranch, scoutBranch
    + " if (x) return { status: 'FAIL', reason: scoutReason('scout-commands-run') };")), []);
  for (const reason of ['scoutReason(key)', "scoutReason('scout-commands-run' + suffix)", "buildReason('build-commit')"]) {
    const extra = ` if (x) return { status: 'FAIL', reason: ${reason} };`;
    assert.ok(problemsOf(mutated(scoutBranch, scoutBranch + extra))
      .includes(`branch reason bypasses catalog: codex-scout: ${tokensOf(reason).join(' ')}`));
  }
});

test('branch guard rejects static template text and permits only a judge reason as its first interpolation', () => {
  for (const reason of ['`prefix ${gap}`', '`${gap} suffix`', '`${hooks}${gap}`', '`${gap.other}${hooks}`']) {
    const anchor = "if (gap) return { status: 'FAIL', reason: gap };\n    const contextGap";
    const edited = mutated(anchor, `if (gap) return { status: 'FAIL', reason: ${reason} };\n    const contextGap`);
    assert.ok(problemsOf(edited).includes(`branch reason bypasses catalog: codex-scout: ${reason}`));
  }
});

test('branch guard exempts only literal OK status and handles single-statement agent branches', () => {
  assert.deepEqual(problemsOf(mutated(scoutBranch, scoutBranch + " return { status: 'OK', reason: 'x' };")), []);
  for (const status of ["'FAIL'", "'LIMIT'", "'UNAVAILABLE'", 'computed']) {
    const extra = `if (agent === 'codex-scout') return { status: ${status}, reason: 'x' };\n`;
    assert.ok(problemsOf(mutated(scoutBranch, extra + scoutBranch))
      .includes("branch reason bypasses catalog: codex-scout: 'x'"));
  }
});

test('branch guard requires every registered entry to be called in its own agent branch', () => {
  for (const { agent, entries } of JUDGED_AGENTS) {
    for (const entry of entries) {
      const anchor = new RegExp(`const \\w+ = ${entry}\\([^;]+;`).exec(source)?.[0];
      assert.ok(anchor, `mutation anchor missing: ${entry}`);
      const edited = mutated(anchor, anchor.replace(entry, 'unregistered'));
      assert.ok(problemsOf(edited).includes(`judge entry not called: ${agent}: ${entry}`));
    }
  }
});

test('host reason exceptions are closed frozen maps with decision evidence', () => {
  assert.deepEqual(Object.keys(HOST_REASON_FUNCTIONS), ['snapshotRefusal']);
  assert.deepEqual(Object.keys(HOST_REASON_SUFFIXES), ['hooks']);
  for (const map of [HOST_REASON_FUNCTIONS, HOST_REASON_SUFFIXES]) {
    assert.ok(Object.isFrozen(map));
    for (const reason of Object.values(map)) assert.ok(reason.includes('Plan_80 E21'));
  }
});
