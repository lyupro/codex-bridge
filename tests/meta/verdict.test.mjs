#!/usr/bin/env node
/**
 * Guards verdict.mjs: outOfScope and reportVersusWork, called directly.
 *   node --test agents/codex-bridge/meta/verdict.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect } from '../../src/write-meta.mjs';
import { outOfScope, reportVersusWork } from '../../src/meta/verdict.mjs';
import { makeChainRoot, makeRun, CHAIN_REPO, CHAIN_SLUG } from './test-fixtures.mjs';

const build = (changes, extra = {}) => ({
  summary: 'done',
  changes,
  verify_command: 'npm test',
  verify_passed: true,
  leftovers: [],
  report_markdown: '# report',
  ...extra,
});

/** The task context reportVersusWork() gets from status.json in production. */
const chainCtx = (runsRoot) => ({ runsRoot, repo: CHAIN_REPO, slug: CHAIN_SLUG });

// --- outOfScope, as a pure function ---------------------------------------------------

test('a backslash path from Codex matches a forward-slash pattern from git', () => {
  const backslashPath = ['src', 'a.ts'].join(String.fromCharCode(92));
  assert.deepEqual(outOfScope([backslashPath], ['src/**']), []);
});

test('outOfScope flags a service directory even when a pattern explicitly allows it', () => {
  assert.deepEqual(outOfScope(['.git/config'], ['.git/**']), ['.git/config']);
});

// --- reportVersusWork, called directly ------------------------------------------------

test('reportVersusWork agrees when the declared file is in this run own delta', () => {
  const root = makeChainRoot([
    { name: 'only', at: '2026-07-31T10:00:00Z', before: '', after: 'U\t10\tsrc/a.ts\n' },
  ]);
  const verdict = reportVersusWork(
    path.join(root, 'only'),
    build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    chainCtx(root),
  );
  assert.deepEqual(verdict, { ok: true, carried: false, reason: null });
});

test('declared paths match touched paths without regard to case', () => {
  const root = makeChainRoot([
    { name: 'only', at: '2026-07-31T10:00:00Z', before: '', after: 'U\t10\tCHANGELOG.md\n' },
  ]);
  const verdict = reportVersusWork(
    path.join(root, 'only'),
    build([{ file: 'changelog.md', what: 'change', why: 'task' }]),
    chainCtx(root),
  );
  assert.deepEqual(verdict, { ok: true, carried: false, reason: null });
});

test('reportVersusWork carries work an earlier pass of the same task already did', () => {
  const root = makeChainRoot([
    { name: 'a-first', at: '2026-07-31T10:00:00Z', before: '', after: 'U\t10\tsrc/a.ts\n' },
    { name: 'b-second', at: '2026-07-31T12:00:00Z', before: 'U\t10\tsrc/a.ts\n', after: 'U\t10\tsrc/a.ts\n' },
  ]);
  const verdict = reportVersusWork(
    path.join(root, 'b-second'),
    build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    chainCtx(root),
  );
  assert.deepEqual(verdict, { ok: true, carried: true, reason: null });
});

test('a service-directory claim fails even where the chain would vouch for the same shape', () => {
  // Identical fixture either way, so the only thing measured is that the service check is
  // asked before the chain is: no earlier pass of any task grants the right to edit
  // `.claude/`, and finding such a path in the chain would excuse the one thing that cannot be.
  const shape = (file) => {
    const root = makeChainRoot([
      { name: 'a-first', at: '2026-07-31T10:00:00Z', before: '', after: `U\t10\t${file}\n` },
      { name: 'b-second', at: '2026-07-31T12:00:00Z', before: `U\t10\t${file}\n`, after: `U\t10\t${file}\n` },
    ]);
    return reportVersusWork(
      path.join(root, 'b-second'),
      build([{ file, what: 'change', why: 'task' }]),
      chainCtx(root),
    );
  };

  assert.deepEqual(shape('src/a.ts'), { ok: true, carried: true, reason: null });

  const service = shape('.claude/settings.json');
  assert.equal(service.ok, false);
  assert.match(service.reason, /service directories/);
});

test('reportVersusWork names both sides when neither matches the other', () => {
  const root = makeChainRoot([
    { name: 'only', at: '2026-07-31T10:00:00Z', before: '', after: 'U\t10\tsrc/b.ts\n' },
  ]);
  const verdict = reportVersusWork(
    path.join(root, 'only'),
    build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    chainCtx(root),
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.carried, false);
  assert.match(verdict.reason, /report names src\/a\.ts, but src\/b\.ts changed/);
});

test('a file the tooling wrote during the run is not work the report owes an entry for', () => {
  // The 2026-08-02 run: three scoped files edited, and .omc/project-memory.json rewritten by
  // OMC while Codex worked. Same fixture twice — the only difference is whether the run
  // recorded what the environment writes.
  const shape = (envPaths) => {
    const root = makeChainRoot([
      {
        name: 'only',
        at: '2026-08-02T00:20:00Z',
        envPaths,
        before: '',
        after: 'U\t10\t.omc/project-memory.json\n',
      },
    ]);
    return reportVersusWork(path.join(root, 'only'), build([]), chainCtx(root));
  };

  assert.deepEqual(shape(['.omc/**']), { ok: true, carried: false, reason: null });

  const unrecorded = shape(undefined);
  assert.equal(unrecorded.ok, false);
  assert.match(unrecorded.reason, /names no changes/);
});

test('reportVersusWork fails a changed tree the report never mentions', () => {
  const root = makeChainRoot([
    { name: 'only', at: '2026-07-31T10:00:00Z', before: '', after: 'U\t120\tsrc/new.ts\n' },
  ]);
  const verdict = reportVersusWork(path.join(root, 'only'), build([]), chainCtx(root));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /names no changes/);
});

// The incident behind Plan_15: the quota line came from this package's own test fixtures,
// which a run had printed as diagnostic text while grepping the repository.
const QUOTA = 'ERROR: rate limit exceeded for this account\n';
const emptyBuild = { summary: '', changes: [], report_markdown: '' };

test('stderr quoting a quota is not LIMIT when events carry no transport error', () => {
  const dir = makeRun({
    stderr: QUOTA,
    args: ['exec', '--json'],
    events: [{ type: 'item.completed', item: { type: 'agent_message', text: QUOTA } }],
    result: emptyBuild,
  });
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'FAIL');
  assert.doesNotMatch(meta.reason, /abandoned at startup/);
});

/**
 * Order guard. "Abandoned at startup" sits above every accusation about the run's conduct,
 * where the empty-raw.log check sat before it: HEAD moving in the window of a run that never
 * started is somebody else's commit, and answering that with "commit made despite prohibition"
 * would blame a run that did not exist.
 */
test('a run that never started is abandoned, not accused of the commit in its window', () => {
  const dir = makeRun({
    stderr: '',
    args: ['exec', '--json'],
    events: [],
    result: emptyBuild,
    headBefore: 'abcdef1234567890\n',
    headAfter: 'fedcba0987654321\n',
  });

  const { meta } = collect(dir, 'codex-build', 1);

  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /abandoned at startup/);
  assert.doesNotMatch(meta.reason, /commit made/);
});

test('a structured quota error is still a LIMIT', () => {
  const dir = makeRun({
    stderr: QUOTA,
    args: ['exec', '--json'],
    events: [{ type: 'error', message: QUOTA }],
    result: emptyBuild,
  });
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'LIMIT');
  assert.match(meta.reason, /rate limit/);
});

test('a deadline verdict outranks a structured quota error', () => {
  const dir = makeRun({
    stderr: QUOTA,
    args: ['exec', '--json'],
    events: [{ type: 'error', message: QUOTA }],
    status: { stopped_on_deadline: true, elapsed_ms: 60012 },
    result: emptyBuild,
  });
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /deadline after 60012 ms/);
  assert.doesNotMatch(meta.reason, /rate limit/);
});

test('an archived run without --json is judged without transport damage', () => {
  const dir = makeRun({ args: ['exec'], stderr: '', result: emptyBuild });
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'FAIL');
  assert.doesNotMatch(meta.reason, /artifacts disagree/);
});

test('no events and empty stderr means abandoned at startup', () => {
  const dir = makeRun({ args: ['exec', '--json'], events: [], stderr: '', result: emptyBuild });
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /abandoned at startup/);
});

test('no events but non-empty stderr is a plain FAIL with the stderr reason', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [],
    stderr: 'panic: worker died before producing a result\n',
    result: emptyBuild,
  });
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /panic: worker died/);
  assert.doesNotMatch(meta.reason, /abandoned at startup/);
});

test('a new run missing events.jsonl is a damaged-evidence failure', () => {
  const dir = makeRun({ args: ['exec', '--json'], stderr: '', result: emptyBuild });
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /evidence was damaged/);
  assert.match(meta.reason, /quota refusal cannot be told apart/);
});

// A deadline watcher and stderr.log are produced by the same worker. Removing stderr.log after
// that fact is recorded must remain a consistency failure, even when the event stream exists.
test('a deadline watcher without stderr.log is a damaged-evidence failure', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [],
    status: { stopped_on_deadline: false, elapsed_ms: 4200 },
    result: emptyBuild,
  });
  fs.rmSync(path.join(dir, 'stderr.log'));
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /artifacts disagree/);
});

test('a turn.failed status 429 event is LIMIT', () => {
  const dir = makeRun({
    log: 'codex started\n',
    events: [
      {
        type: 'turn.failed',
        error: {
          message: JSON.stringify({
            status: 429,
            error: { type: 'server_error', message: 'request refused' },
          }),
        },
      },
    ],
    result: emptyBuild,
  });

  const { meta } = collect(dir, 'codex-build', 1);

  assert.equal(meta.status, 'LIMIT');
  assert.match(meta.reason, /status 429/);
});

test('an item.completed quotation about a quota is not LIMIT', () => {
  const dir = makeRun({
    log: 'agent quoted: rate limit exceeded\n',
    events: [{ type: 'item.completed', item: { type: 'agent_message', text: 'rate limit exceeded' } }],
    result: emptyBuild,
  });

  const { meta } = collect(dir, 'codex-build', 1);

  assert.equal(meta.status, 'FAIL');
});

test('an error type naming a limit is LIMIT without status 429', () => {
  const dir = makeRun({
    log: 'codex started\n',
    events: [
      {
        type: 'error',
        message: JSON.stringify({
          status: 400,
          error: { type: 'rate_limit_error', message: 'provider refused the request' },
        }),
      },
    ],
    result: emptyBuild,
  });

  const { meta } = collect(dir, 'codex-build', 1);

  assert.equal(meta.status, 'LIMIT');
  assert.match(meta.reason, /rate_limit_error/);
});

test('a non-quota transport event supplies the FAIL reason before raw text', () => {
  const dir = makeRun({
    log: 'raw text says rate limit exceeded\n',
    events: [
      {
        type: 'error',
        message: JSON.stringify({
          status: 400,
          error: { type: 'invalid_request_error', message: 'request body is invalid' },
        }),
      },
    ],
    result: emptyBuild,
  });

  const { meta } = collect(dir, 'codex-build', 1);

  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /request body is invalid/);
  assert.doesNotMatch(meta.reason, /rate limit exceeded/);
});

test('a transport error the run recovered from does not fail a completed run', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
    events: [
      {
        type: 'error',
        message: JSON.stringify({
          status: 503,
          error: { type: 'server_error', message: 'stream disconnected before completion' },
        }),
      },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
    ],
  });

  const { meta } = collect(dir, 'codex-build', 0);

  assert.equal(meta.status, 'OK');
});

test('an error about a context length limit is not read as a quota refusal', () => {
  const dir = makeRun({
    log: 'codex started\n',
    events: [
      {
        type: 'turn.failed',
        error: {
          message: JSON.stringify({
            status: 400,
            error: { type: 'invalid_request_error', message: 'context length limit exceeded' },
          }),
        },
      },
    ],
    result: emptyBuild,
  });

  const { meta } = collect(dir, 'codex-build', 1);

  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /context length limit/);
});
