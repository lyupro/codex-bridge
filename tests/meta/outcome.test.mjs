#!/usr/bin/env node
/**
 * Guards meta/outcome.mjs: which runs are judged by the declared outcome, and what each
 * declaration means. The run this file exists for is 2026-08-04_202959_build — an impossible
 * order answered `OK`, because a clean tree is a legitimate outcome and the runner could not
 * tell the two apart.
 *   npm test -- tests/meta/outcome.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeGap, requiresOutcome } from '../../src/home/lib/meta/outcome.mjs';
import { SCHEMAS } from '../../src/home/lib/runner/schemas.mjs';
import { buildResult, makeRun } from './test-fixtures.mjs';

// The production schema is used rather than a hand-written stand-in: the marker and the
// contract are the same file, so a test that invented its own would stop noticing if the
// field ever left the schema.
const BUILD_SCHEMA = SCHEMAS['codex-build'];

/** A run folder that ran under today's contract, the way the launcher writes one. */
const underContract = () => makeRun({ result: buildResult([]), schema: BUILD_SCHEMA });

/** The same result the schema demands, minus the field itself. */
const withoutOutcome = () => {
  const { outcome, ...rest } = buildResult([]);
  return rest;
};

test('the schema handed to the run is what says an outcome was owed', () => {
  assert.equal(requiresOutcome(underContract()), true);
  // No schema.json at all: a run folder from before this contract, or an archive replay.
  assert.equal(requiresOutcome(makeRun({ result: buildResult([]) })), false);
  // A schema that predates the field — the same shape, minus outcome.
  const older = { ...BUILD_SCHEMA, required: BUILD_SCHEMA.required.filter((f) => f !== 'outcome') };
  assert.equal(requiresOutcome(makeRun({ result: buildResult([]), schema: older })), false);
});

test('a declared failure names its reason from summary', () => {
  const result = buildResult([], {
    outcome: 'fail',
    summary: 'target module is absent from the checkout',
  });
  assert.match(
    outcomeGap(underContract(), result),
    /the task was not done: target module is absent from the checkout/,
  );
});

test('a declared success is not itself a verdict, only the end of this check', () => {
  const result = buildResult([{ file: 'src/a.ts', what: 'change', why: 'task' }]);
  assert.equal(outcomeGap(underContract(), result), null);
});

test('a missing field under the contract is an unfilled result, not a pass', () => {
  assert.match(outcomeGap(underContract(), withoutOutcome()), /result is not filled in/);
});

test('a value outside the enum is named rather than silently treated as done', () => {
  assert.match(
    outcomeGap(underContract(), buildResult([], { outcome: 'partially' })),
    /unknown outcome “partially”/,
  );
});

test('a success spelled any way but the enum way is not a success', () => {
  // The values are compared exactly. Normalising case and whitespace first would let "DONE"
  // and " done " — which Codex would have rejected against the schema — pass as done, and a
  // malformed success is precisely what this check exists to catch. A malformed failure is
  // still red, only by the unknown-value branch, so strictness costs nothing there.
  for (const value of ['DONE', ' done ', 'Done', 'done\n']) {
    assert.match(
      outcomeGap(underContract(), buildResult([], { outcome: value })),
      /unknown outcome/,
      value,
    );
  }
  for (const value of ['FAIL', ' fail']) {
    assert.match(
      outcomeGap(underContract(), buildResult([], { outcome: value })),
      /unknown outcome/,
      value,
    );
  }
});

test('a non-string value is refused instead of being coerced', () => {
  for (const value of [true, 1, { outcome: 'done' }, ['done']]) {
    assert.match(
      outcomeGap(underContract(), buildResult([], { outcome: value })),
      /unknown outcome/,
      JSON.stringify(value),
    );
  }
  // null and an empty string are the unfilled result, not an unknown value.
  assert.match(outcomeGap(underContract(), buildResult([], { outcome: null })), /not filled in/);
});

test('an archived run is never asked for an outcome it was not contracted to give', () => {
  const archived = makeRun({ result: buildResult([]) });
  assert.equal(outcomeGap(archived, withoutOutcome()), null);
  // Even an explicit failure in an archived result is ignored: that run was graded under the
  // contract of its own day, and re-reading it under today's rules would rewrite history.
  assert.equal(outcomeGap(archived, buildResult([], { outcome: 'fail' })), null);
});

test('a declared failure without a summary still says who declared it', () => {
  assert.match(
    outcomeGap(underContract(), buildResult([], { outcome: 'fail', summary: '' })),
    /build declared fail and gave no summary/,
  );
});
