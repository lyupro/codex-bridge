#!/usr/bin/env node
/**
 * Guards the write-meta.mjs facade on its declared-outcome axis: a build run states whether it
 * did the work, and collect() believes the statement ahead of the tree.
 *   npm test -- tests/write-meta-outcome.test.mjs
 *
 * The run behind this file is 2026-08-04_202959_build: asked to fix a function in a module that
 * is not in the checkout, it answered `OK — No code change was made`. Every artifact was
 * well-formed and the tree was legitimately clean, so no existing check could object — the
 * outcome had to stop being inferred. Placement matters as much as the check: it sits below
 * verification (a red command is still the louder failure) and above scope (work never done
 * outranks where it was not done), and the order is the contract in docs/verdict.md.
 *
 * Its unit-level twin is meta/outcome.test.mjs; the same facade's other axes live in
 * write-meta.test.mjs, write-meta-scout.test.mjs and write-meta-git-state.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../src/home/lib/write-meta.mjs';
import { SCHEMAS } from '../src/home/lib/runner/schemas.mjs';
import { INSTRUCTIONS } from '../src/home/lib/runner/prompts.mjs';
import { buildResult as build, makeRun } from './meta/test-fixtures.mjs';

const BUILD_SCHEMA = SCHEMAS['codex-build'];

test('a declared failure fails the run even with a clean tree and green verification', () => {
  // The 2026-08-04 shape exactly: nothing changed, nothing claimed, verification green.
  const dir = makeRun({
    schema: BUILD_SCHEMA,
    result: build([], { outcome: 'fail', summary: 'the target module is absent from the checkout' }),
    before: '',
    after: '',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /the task was not done: the target module is absent/);
});

test('the same run without the declaration is the OK this plan was written to remove', () => {
  // Identical fixture minus schema.json and the field: an archived run keeps the verdict it
  // was given on the day it ran. This is the behaviour the marker preserves, not a regression.
  const { outcome, ...archived } = build([]);
  const dir = makeRun({ result: archived, before: '', after: '' });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('a contracted run that leaves the field empty is an unfilled result', () => {
  const { outcome, ...withoutField } = build([]);
  const dir = makeRun({ schema: BUILD_SCHEMA, result: withoutField, before: '', after: '' });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /result is not filled in/);
});

test('a red verification still outranks the declared outcome', () => {
  // Both would fail the run; the reason has to be the command that broke, because that is
  // what the orchestrator acts on first.
  const dir = makeRun({
    schema: BUILD_SCHEMA,
    result: build([], { outcome: 'fail', summary: 'nothing was possible', verify_passed: false }),
    before: '',
    after: '',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /verification/);
});

test('the declared outcome outranks scope and the report-versus-tree check', () => {
  // A run that both failed its task and wandered outside scope: the orchestrator is told the
  // work was not done, not where it was not done.
  const dir = makeRun({
    schema: BUILD_SCHEMA,
    result: build([], { outcome: 'fail', summary: 'the order contradicts itself' }),
    scope: 'src/**\n',
    before: '',
    after: 'U\t10\tdocs/notes.md\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /the task was not done/);
});

test('a declared success is still judged by the tree', () => {
  // The field adds a reason to go red; it removes none. A run claiming done while the report
  // names a file nothing touched fails exactly as it did before.
  const dir = makeRun({
    schema: BUILD_SCHEMA,
    result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tsrc/b.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /wrong work was done/);
});

test('a failed build says what it left in the tree, like a LIMIT does', () => {
  // "The work was not done" is not "the tree is clean": a run can write half a change and
  // then declare fail. Without this line the orchestrator has to go and look.
  const dir = makeRun({
    schema: BUILD_SCHEMA,
    result: build([], { outcome: 'fail', summary: 'ran out of time' }),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
  });
  const { reply } = collect(dir, 'codex-build', 0);
  assert.match(reply, /Worktree: has unfinished changes \(1\): src\/a\.ts/);
});

test('a failed build with a clean tree says so rather than staying silent', () => {
  const dir = makeRun({
    schema: BUILD_SCHEMA,
    result: build([], { outcome: 'fail', summary: 'the target module is absent' }),
    before: '',
    after: '',
  });
  const { reply } = collect(dir, 'codex-build', 0);
  assert.match(reply, /Worktree: no new changes/);
});

test('a build with no snapshot admits the tree state is unknown', () => {
  // A killed run never wrote state-after.txt. Printing "no new changes" from missing data is
  // the mistake status.json's tree_after: false exists to prevent.
  const dir = makeRun({
    schema: BUILD_SCHEMA,
    after: null,
    result: build([], { outcome: 'fail', summary: 'killed by the deadline' }),
  });
  const { reply } = collect(dir, 'codex-build', 0);
  assert.match(reply, /Worktree: unknown — the run left no worktree snapshot/);
});

test('scout and review keep a fail reply without a worktree line', () => {
  // The line is about a writing run's leftovers; a read-only agent has none to report.
  const dir = makeRun({ result: { answer: '' }, log: 'ERROR: something broke\n' });
  const { reply } = collect(dir, 'codex-scout', 1);
  assert.match(reply, /^FAIL/);
  assert.doesNotMatch(reply, /Worktree:/);
});

test('scout and review are not judged by a field they were never asked for', () => {
  // Deliberate asymmetry, decided 2026-08-04: scout states its outcome through coverage of the
  // sub-questions, review through its verdict. A second mandatory outcome field beside those
  // could disagree with them silently.
  for (const agent of ['codex-scout', 'codex-review']) {
    assert.equal(SCHEMAS[agent].required.includes('outcome'), false, agent);
  }
});

test('the build contract carries the outcome field, and the prompt explains both values', () => {
  // The guard against the halves drifting: the schema is what makes a run contracted (the
  // marker meta/outcome.mjs reads), and the prompt is the only place the model learns what
  // the values mean. A schema with no matching instruction is a field filled in by guesswork.
  assert.equal(BUILD_SCHEMA.required.includes('outcome'), true);
  assert.deepEqual(BUILD_SCHEMA.properties.outcome.enum, ['done', 'fail']);

  const prompt = INSTRUCTIONS['codex-build']({ verify: 'npm test' });
  assert.match(prompt, /outcome/);
  for (const value of ['"done"', '"fail"']) assert.ok(prompt.includes(value), value);
});
