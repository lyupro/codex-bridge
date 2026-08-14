/**
 * The outcome a build run declared about itself, and whether it was contracted to declare one.
 *
 * The runner cannot infer this. On 2026-08-04 (`2026-08-04_202959_build`) a build was asked to
 * fix a function in a module absent from the checkout and answered `OK — No code change was
 * made because the requested target file is absent`: every artifact was well-formed and a clean
 * tree is a legitimate outcome for "check and fix if broken", so nothing in the verdict could
 * object. Plan_12 moved the outcome from inference to declaration — the executor states it, the
 * runner reads it.
 *
 * The contract marker is the run's own schema.json, not a version number written beside it. The
 * schema IS the contract Codex was handed, so "was this run required to declare an outcome" and
 * "what was it required to answer" cannot drift apart: they are the same file. A run from before
 * this version, or a replay of an archived folder, has no `outcome` in its schema and keeps the
 * verdict it always had.
 */
import path from 'node:path';
import { line, readJson } from './paths.mjs';

const FIELD = 'outcome';

/** The values schemas.mjs allows; anything else in a result.json is a broken answer. */
const DONE = 'done';
const FAIL = 'fail';

/**
 * Was this run handed a schema that demands an outcome? Read off the run's own schema.json,
 * which the launcher writes before Codex is invoked, so the answer describes the contract this
 * run actually ran under rather than the one the current source happens to define.
 */
export function requiresOutcome(runDir) {
  const schema = readJson(path.join(runDir, 'schema.json'));
  return Array.isArray(schema?.required) && schema.required.includes(FIELD);
}

/**
 * Why the declared outcome fails the run, or null when it does not. Three ways to fail: the
 * executor said the work was not done; the field is missing although the schema required it
 * (Codex enforces the schema, so this is a hand-edited or truncated result rather than a normal
 * answer); the field holds a value the enum does not define.
 *
 * A declared `done` is not proof of anything — it only stops here. The tree, the scope and the
 * report are checked after this, exactly as before: the field adds a reason to go red, it
 * removes none.
 */
export function outcomeGap(runDir, result) {
  if (!requiresOutcome(runDir)) return null;
  // Compared exactly, never normalised. Trimming and lower-casing would let `"DONE"` or
  // `" done "` — values the enum forbids and Codex would have rejected — buy their way past
  // this check, and a malformed success is exactly the shape this file exists to stop. A
  // malformed failure loses nothing by the same rule: it still goes red, only by the
  // unknown-value branch.
  const declared = result?.[FIELD];
  if (declared === DONE) return null;
  if (declared === FAIL) {
    // The reason comes from summary rather than a field of its own: summary is already
    // mandatory and already describes what happened, and two fields about one thing drift.
    const stated = line(result?.summary || '', 240);
    return `the task was not done: ${stated || 'build declared fail and gave no summary'}`;
  }
  if (declared === undefined || declared === null || declared === '') {
    return 'result is not filled in: the response contract requires outcome "done" or "fail"';
  }
  return `result declares an unknown outcome “${line(String(declared), 40)}”, expected "done" or "fail"`;
}
