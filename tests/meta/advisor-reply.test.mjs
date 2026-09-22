/**
 * Plan_59 D4/D6: what an advisor run prints and records. An insufficient scope is an OK run whose
 * outcome is a field in meta.json and the first thing after the status word — never a LIMIT, whose
 * meaning (quota gone, stop delegating) calls for the opposite reaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AGENTS, collect } from '../../src/home/lib/write-meta.mjs';
import { validAdvice, validScope } from './advisor-fixtures.mjs';
import { makeRun } from './test-fixtures.mjs';

const reply = (result) => {
  const runDir = path.join('runs', 'advisor-run');
  return AGENTS['codex-advisor'].reply({
    runDir,
    result,
    resultPath: path.join(runDir, 'result.json'),
    file: (name) => path.join(runDir, name),
  });
};

test('either phase result counts as filled, an empty one does not', () => {
  const { filled } = AGENTS['codex-advisor'];
  assert.equal(filled(validScope()), true);
  assert.equal(filled({ ...validScope(), sufficient: false }), true);
  assert.equal(filled(validAdvice()), true);
  assert.equal(filled({}), false);
  assert.equal(filled({ recommendation: { option_id: ' ' } }), false);
});

test('a sufficient scope says so and points to the advise phase', () => {
  const rows = reply(validScope());
  assert.equal(rows[0], 'OK — scope: sufficient; continue this run with --phase advise');
  assert.equal(rows.some((row) => row.startsWith('Missing:')), false);
  assert.match(rows.at(-1), /^Report: .*result\.json · Log: codex-bridge read /);
});

test('an insufficient scope names its outcome and the paths it needs', () => {
  const rows = reply({ ...validScope(), sufficient: false, missing_paths: ['src/a.mjs', 'src/b.mjs'] });
  assert.equal(rows[0], 'OK — scope: insufficient; 2 paths named');
  assert.equal(rows[1], 'Missing: src/a.mjs, src/b.mjs');
  assert.match(rows[2], /^Predicted risks: 3 — r1 /);
});

test('advice leads with the recommended option and counts the settled risks', () => {
  const rows = reply(validAdvice());
  assert.equal(rows[0], 'OK — recommend keep: Keep the current boundary.');
  assert.match(rows[1], /^Rejected: split \(Requires a coordinated caller migration\.\)$/);
  assert.match(rows[2], /^Counter: The existing boundary/);
  assert.equal(rows[3], 'Risks: 2 confirmed · 1 refuted · open questions 2 · confidence medium');
  assert.ok(rows.length <= 5);
});

test('meta.json records the scope outcome for advisors and the named advice for builds', () => {
  const scope = collect(makeRun({ result: { ...validScope(), sufficient: false, missing_paths: ['src/a.mjs'] } }),
    'codex-advisor', 0).meta;
  assert.equal(scope.sufficient, false);
  assert.deepEqual(scope.missing_paths, ['src/a.mjs']);
  assert.equal(Object.hasOwn(scope, 'advice'), false);

  const empty = collect(makeRun({ result: {} }), 'codex-advisor', 0).meta;
  assert.equal(empty.sufficient, null);
  assert.equal(empty.missing_paths, null);

  const build = collect(makeRun({ result: { summary: 'done', changes: [] }, status: { advice: 'mechanical' } }),
    'codex-build', 0).meta;
  assert.equal(build.advice, 'mechanical');
  assert.equal(Object.hasOwn(build, 'sufficient'), false);
  assert.equal(collect(makeRun({ result: { summary: 'done', changes: [] } }), 'codex-build', 0).meta.advice, null);
});
