#!/usr/bin/env node
/** Plan_80 E13/O7: account for resumed threads without changing fresh-run metadata or replies. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect } from '../src/home/lib/write-meta.mjs';
import { buildResult as build, COMPLETED_COMMAND, makeRun } from './meta/test-fixtures.mjs';

function collectResume({ resumed_from = 'failed-pass', resume, args }) {
  const dir = makeRun({
    status: { resumed_from }, result: build([]), before: '', after: '',
    events: [{ type: 'thread.started', thread_id: 'resume-thread' }],
  });
  fs.writeFileSync(path.join(dir, 'worker.json'), `${JSON.stringify({ args, resume })}\n`);
  const collected = collect(dir, 'codex-build', 0);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.equal(collected.meta.status, 'OK', collected.meta.reason);
  assert.equal(persisted.resumed_from, collected.meta.resumed_from);
  assert.equal(persisted.sandbox, collected.meta.sandbox);
  return collected;
}

test('a resume records its source run and read-only worker sandbox without --sandbox', () => {
  const { meta, reply } = collectResume({
    resume: { thread_id: 'resume-thread', resumed_from: 'failed-pass', sandbox_mode: 'read-only' },
    args: ['exec', 'resume', '--json', '-c', 'sandbox_mode=read-only', 'resume-thread'],
  });
  assert.equal(meta.resumed_from, 'failed-pass');
  assert.equal(meta.sandbox, 'read-only');
  assert.ok(reply.split('\n').includes("Attempt: resume of failed-pass — continues that pass's Codex thread"));
});

test('a fresh run always records resumed_from: null and preserves its --sandbox value', () => {
  for (const resumed_from of [undefined, null, '', '   ', 42]) {
    const dir = makeRun({
      status: { resumed_from }, result: build([]), args: ['exec', '--sandbox', 'workspace-write'],
    });
    const { meta, reply } = collect(dir, 'codex-build', 0);
    assert.equal(meta.resumed_from, null);
    assert.equal(meta.sandbox, 'workspace-write');
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    assert.equal(persisted.resumed_from, null);
    assert.equal(persisted.sandbox, 'workspace-write');
    assert.doesNotMatch(reply, /^Attempt:/m);
  }
});

test('a resume without worker.resume keeps the existing absent sandbox value', () => {
  const { meta } = collectResume({ args: ['exec', 'resume', '--json', 'resume-thread'] });
  assert.equal(meta.resumed_from, 'failed-pass');
  assert.equal(meta.sandbox, null);
});

test('an explicit --sandbox takes precedence over the resume sandbox record', () => {
  for (const sandbox of ['workspace-write', '']) {
    const { meta } = collectResume({
      resume: { sandbox_mode: 'read-only' }, args: ['exec', '--sandbox', sandbox],
    });
    assert.equal(meta.sandbox, sandbox);
  }
});

test('missing, empty and non-string resume sandbox modes preserve the existing null', () => {
  for (const sandbox_mode of [undefined, null, '', '   ', 42]) {
    const { meta } = collectResume({
      resume: { sandbox_mode }, args: ['exec', 'resume', '--json', 'resume-thread'],
    });
    assert.equal(meta.sandbox, null);
  }
});

test('resume accounting copies status provenance instead of worker provenance', () => {
  const { meta } = collectResume({
    resume: { resumed_from: 'different-worker-source', sandbox_mode: 'read-only' },
    args: ['exec', 'resume', '--json', 'resume-thread'],
  });
  assert.equal(meta.resumed_from, 'failed-pass');
});

test('collect persists the resume execution chain while status and reason stay unchanged', () => {
  const predecessor = makeRun({
    events: [
      { type: 'thread.started', thread_id: 'resume-thread' },
      ...Array.from({ length: 8 }, () => COMPLETED_COMMAND),
    ],
  });
  const dir = makeRun({
    status: { resumed_from: path.basename(predecessor) }, result: build([]),
    events: [{ type: 'thread.started', thread_id: 'resume-thread' }],
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
  assert.equal(meta.reason, null);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  assert.deepEqual(persisted.commands_executed, {
    version: 1, run: 0, chain: 8, chain_runs: [path.basename(predecessor)], gap: null,
  });
  assert.equal(persisted.status, 'OK');
  assert.equal(persisted.reason, null);
});
