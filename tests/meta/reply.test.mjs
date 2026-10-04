#!/usr/bin/env node
/** Verifies replies point operators at the structured read command and name both artifacts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { AGENTS } from '../../src/home/lib/meta/reply.mjs';
import { buildResult, COMPLETED_COMMAND, makeRun } from './test-fixtures.mjs';

for (const [agent, field] of [['codex-build', 'summary'], ['codex-scout', 'answer']]) {
  test(`${agent} strips one leading model verdict and preserves all other reply rows`, () => {
    const dir = makeRun({
      args: ['exec', '--json'],
      events: [{ type: 'thread.started', thread_id: 'reply-model-verdict' }],
      result: buildResult([]),
    });
    const ctx = { runDir: dir, file: (name) => path.join(dir, name), result: { [field]: 'probe waited' } };
    const baseline = AGENTS[agent].reply(ctx);
    const cases = [
      ['OK — probe waited', 'probe waited'],
      ['FAIL: x', 'x'],
      ['fixed OK — y', 'fixed OK — y'],
      ['OK — OK — probe waited', 'OK — probe waited'],
      ['ok — probe waited', 'ok — probe waited'],
      ['OK', 'OK'],
      ['OK:probe waited', 'OK:probe waited'],
      ['OK -probe waited', 'OK -probe waited'],
      ['OKAY — probe waited', 'OKAY — probe waited'],
      ['prefix\nOK — probe waited', 'prefix OK — probe waited'],
    ];
    for (const verdict of ['OK', 'FAIL', 'LIMIT', 'UNAVAILABLE']) {
      for (const separator of [' — ', ' - ', ': ']) {
        cases.push([`${verdict}${separator}probe waited`, 'probe waited']);
      }
    }
    for (const [text, expected] of cases) {
      const rows = AGENTS[agent].reply({ ...ctx, result: { [field]: text } });
      assert.equal(rows[0], `OK — ${expected}`, text);
      assert.deepEqual(rows.slice(1), baseline.slice(1), text);
    }
  });
}

test('successful replies use the read command instead of a raw file path', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [{ type: 'thread.started', thread_id: 'reply-1' }, COMPLETED_COMMAND],
    result: {
      answer: 'The reply points the operator at the structured read command so the run can be inspected '
        + 'without guessing artifact paths. The command reads the retained events and diagnostic output, '
        + 'and the same link remains available after a successful scout has explained the requested code.',
      findings: [], unknowns: [], report_markdown: '# report',
    },
  });

  const { meta, reply } = collect(dir, 'codex-scout', 0);

  assert.equal(meta.status, 'OK');
  assert.ok(reply.includes(`Log: codex-bridge read ${dir}`));
  assert.doesNotMatch(reply, /raw\.log/);
});

test('successful build replies preserve summaries longer than the old 160-character limit', () => {
  const summary = `${'verified behavior '.repeat(11)}final marker`;
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [{ type: 'thread.started', thread_id: 'reply-long-summary' }],
    result: buildResult([], { summary }),
  });

  const { reply } = collect(dir, 'codex-build', 0);

  assert.ok(summary.length > 160 && summary.length < 300);
  assert.ok(reply.includes(summary));
});

test('build replies name incomplete flag coverage immediately after the flags row', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [{ type: 'thread.started', thread_id: 'reply-flag-gaps' }],
    result: buildResult([]),
  });
  fs.writeFileSync(path.join(dir, 'flags-coverage.txt'),
    '\na.mjs: start content truncated\n\nb.mjs: diff failed\n');

  const { meta, reply } = collect(dir, 'codex-build', 0);
  const rows = reply.split('\n');
  const flagsAt = rows.findIndex((row) => row.startsWith('Flags: '));

  assert.equal(meta.status, 'OK');
  assert.notEqual(flagsAt, -1);
  assert.equal(rows[flagsAt + 1],
    'Flags coverage: incomplete — a.mjs: start content truncated (+1 more)');
});

test('build replies shorten a single coverage gap to 120 characters without a more suffix', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [{ type: 'thread.started', thread_id: 'reply-long-flag-gap' }],
    result: buildResult([]),
  });
  fs.writeFileSync(path.join(dir, 'flags-coverage.txt'), `a.mjs: ${'start content '.repeat(15)}end\n`);

  const { reply } = collect(dir, 'codex-build', 0);
  const prefix = 'Flags coverage: incomplete — ';
  const row = reply.split('\n').find((value) => value.startsWith(prefix));

  assert.ok(row);
  assert.ok(row.slice(prefix.length).length <= 120);
  assert.match(row, /a\.mjs: start content/);
  assert.doesNotMatch(row, / end|\(\+\d+ more\)/);
});

for (const coverage of ['', '\n \t\n', null]) {
  const description = coverage === null ? 'absent' : coverage === '' ? 'empty' : 'blank';
  test(`build replies omit flag coverage when its file is ${description}`, () => {
    const dir = makeRun({
      args: ['exec', '--json'],
      events: [{ type: 'thread.started', thread_id: 'reply-complete-flags' }],
      result: buildResult([]),
    });
    if (coverage !== null) fs.writeFileSync(path.join(dir, 'flags-coverage.txt'), coverage);

    const { meta, reply } = collect(dir, 'codex-build', 0);

    assert.equal(meta.status, 'OK');
    assert.doesNotMatch(reply, /^Flags coverage:/m);
  });
}

test('failed replies report events and stderr sizes plus the read command', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [],
    stderr: 'panic: failed before result\n',
    result: buildResult([], { summary: '' }),
  });

  const { reply } = collect(dir, 'codex-build', 1);

  assert.match(reply, /Artifacts: events\.jsonl \d+ B · stderr\.log \d+ B/);
  assert.ok(reply.includes(`Log: codex-bridge read ${dir}`));
  assert.doesNotMatch(reply, /raw\.log|log_bytes/);
});

test('replies report retained bytes from status.json, the only place housekeeping is recorded', () => {
  const retention = { bytes_freed: 41.2 * 1024 * 1024, runs: 12, days: 30 };
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [{ type: 'thread.started', thread_id: 'reply-retention' }],
    result: buildResult([]),
    status: { state: 'running', retention },
  });

  const { reply } = collect(dir, 'codex-build', 0);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));

  assert.match(reply, /Retention: freed 41\.2 MB from 12 runs older than 30 days/);
  assert.deepEqual(status.retention, retention);
});

test('replies omit retention when no bytes were freed', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [{ type: 'thread.started', thread_id: 'reply-no-retention' }],
    result: buildResult([]),
    status: { state: 'running', retention: { bytes_freed: 0, runs: 1, days: 30 } },
  });

  const { reply } = collect(dir, 'codex-build', 0);

  assert.doesNotMatch(reply, /^Retention:/m);
});

/**
 * The row that would have exposed the defect it was written for: for three releases a run answered
 * on a model nobody ordered, and no line of any reply named a model at all.
 */
test('a reply names the ordered worker and where its depth came from', () => {
  const dir = makeRun({
    args: ['exec', '--json', '-m', 'pinned-model'],
    profile: { model: 'pinned-model', model_source: 'config', effort: 'max', effort_source: 'config' },
    events: [{ type: 'thread.started', thread_id: 'reply-profile' }],
    result: buildResult([]),
  });

  const { reply } = collect(dir, 'codex-build', 0);
  const rows = reply.split('\n');

  assert.match(reply, /^Model: pinned-model at max effort \(config\)$/m);
  // Beside the log link rather than at the end: a dispatcher reads the tail of a reply, and the
  // two rows answer the same question — what ran, and where to look it up.
  assert.equal(rows.findIndex((r) => r.startsWith('Model: ')) + 1, rows.findIndex((r) => r.includes('Log: ')));
});

test('a run with no pinned model says so instead of going quiet', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    profile: { model: '', model_source: 'codex default', effort: 'medium', effort_source: 'fallback' },
    events: [{ type: 'thread.started', thread_id: 'reply-default-profile' }],
    result: buildResult([]),
  });

  const { reply } = collect(dir, 'codex-build', 0);

  assert.match(reply, /^Model: codex default at medium effort \(fallback\)$/m);
});

test('an archived run without a profile keeps its reply unchanged', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [{ type: 'thread.started', thread_id: 'reply-archived' }],
    result: buildResult([]),
  });

  const { reply } = collect(dir, 'codex-build', 0);

  assert.doesNotMatch(reply, /^Model:/m);
});
