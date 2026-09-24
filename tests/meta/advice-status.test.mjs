/** Guards the advisor run-artifact boundary and its integration into final status (Plan_59 D3/D4/D5/D10). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempTree } from '../temp-tree.mjs';
import { adviceGap } from '../../src/home/lib/meta/advice-status.mjs';
import { resolveStatus } from '../../src/home/lib/meta/verdict.mjs';
import { parseAdvisorTask } from '../../src/home/lib/meta/advisor-task.mjs';
import { validAdvice, validScope } from './advisor-fixtures.mjs';

const TASK = '## Options\n- keep: Keep the boundary.\n- split: Split the boundary.\n## Paths\n- src/entry.mjs\n';

function fixture() {
  const root = makeTempTree('advisor-status-');
  const repo = path.join(root, 'repo');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'entry.mjs'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, 'docs', 'guide.md'), 'guide\n');
  return { root, repo, runsRoot };
}

function runFolder(tree, name, phase, { task = true, scope } = {}) {
  const dir = path.join(tree.runsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({ phase }));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ phase, repo: tree.repo }));
  fs.writeFileSync(path.join(dir, 'env.json'), JSON.stringify({ answerLanguage: 'English' }));
  if (task) fs.writeFileSync(path.join(dir, 'advisor-task.json'), JSON.stringify({
    ...parseAdvisorTask(TASK), ...(scope === undefined ? {} : { scope }),
  }));
  return dir;
}

const events = (commands_executed = 1) => ({
  hasStream: true, hasEvents: true, commands_executed, transport_error: null, content_error: null,
});

test('valid scope advice has no gap', () => {
  const tree = fixture();
  const dir = runFolder(tree, 'scope', 'scope');
  assert.equal(adviceGap(dir, validScope(), events()), null);
});

test('scope with no executed commands fails the advice contract', () => {
  const tree = fixture();
  const dir = runFolder(tree, 'scope', 'scope');
  assert.match(adviceGap(dir, validScope(), events(0)), /advice contract broken \(1\): D4 commandsRun 0/);
});

test('advise must resolve every risk predicted in phase 1', () => {
  const tree = fixture();
  const scopeResult = { ...validScope(), predicted_risks: [...validScope().predicted_risks, { id: 'r4', risk: 'Another risk.' }] };
  const dir = runFolder(tree, 'advise', 'advise', { scope: { run: 'scope', ...scopeResult } });
  assert.match(adviceGap(dir, validAdvice(), events()), /risk_outcomes/);
});

test('advise can cite a path requested by phase 1', () => {
  const tree = fixture();
  const scopeResult = { ...validScope(), missing_paths: ['docs/guide.md'] };
  const dir = runFolder(tree, 'advise', 'advise', { scope: { run: 'scope', ...scopeResult } });
  const result = validAdvice();
  result.independent_checks[0].evidence = [{ file: 'docs/guide.md', line_start: 1, line_end: 1 }];
  assert.equal(adviceGap(dir, result, events()), null);
});

// Plan_59 D22: the judge reads only the advise run's own snapshot; the scope folder is never created.
test('advise passes with no scope run folder on disk', () => {
  const tree = fixture();
  const scopeResult = { ...validScope(), missing_paths: ['docs/guide.md'] };
  const dir = runFolder(tree, 'advise', 'advise', { scope: { run: 'scope', ...scopeResult } });
  const result = validAdvice();
  result.independent_checks[0].evidence = [{ file: 'docs/guide.md', line_start: 1, line_end: 1 }];
  assert.equal(fs.existsSync(path.join(tree.runsRoot, 'scope')), false);
  assert.equal(adviceGap(dir, result, events()), null);
});

test('advise without task.scope fails the advice contract', () => {
  const tree = fixture();
  const dir = runFolder(tree, 'advise', 'advise');
  assert.match(adviceGap(dir, validAdvice(), events()), /advisor-task\.json#scope is missing the phase-1 predicted_risks/);
});

test('a missing advisor-task.json fails with its artifact name', () => {
  const tree = fixture();
  const dir = runFolder(tree, 'scope', 'scope', { task: false });
  assert.match(adviceGap(dir, validScope(), events()), /advisor-task\.json is missing/);
});

test('an unexpected answer shape returns a reason without throwing', () => {
  const tree = fixture();
  const dir = runFolder(tree, 'scope', 'scope');
  assert.doesNotThrow(() => adviceGap(dir, {}, events()));
  assert.match(adviceGap(dir, {}, events()), /result\.json is missing required fields or has an unexpected shape/);
});

test('resolveStatus fails an advisor run when the advice judge reports a gap', () => {
  const tree = fixture();
  const dir = runFolder(tree, 'scope', 'scope');
  const result = validScope();
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result));
  fs.writeFileSync(path.join(dir, 'raw.log'), 'read repository evidence\n');
  const verdict = resolveStatus({
    resultOk: true, exit: 0, agent: 'codex-advisor', result, runDir: dir, events: events(0),
  });
  assert.equal(verdict.status, 'FAIL');
  assert.match(verdict.reason, /advice contract broken \(1\): D4 commandsRun 0/);
});
