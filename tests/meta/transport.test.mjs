#!/usr/bin/env node
/**
 * Guards the transport contract marker: current runs need their event stream, archived runs do
 * not get rewritten as damaged, and the deadline watcher still requires stderr.log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { transportGap } from '../../src/meta/transport.mjs';
import { makeRun } from './test-fixtures.mjs';

test('a --json run without events.jsonl reports damaged evidence', () => {
  const dir = makeRun({ args: ['exec', '--json'], stderr: '' });

  const reason = transportGap(dir);

  assert.match(reason, /evidence was damaged/);
  assert.match(reason, /quota refusal cannot be told apart/);
});

test('an archived run without --json is not reported as damaged', () => {
  const dir = makeRun({ args: ['exec'], stderr: '' });

  assert.equal(transportGap(dir), null);
});

test('a recorded deadline without stderr.log remains a transport mismatch', () => {
  const dir = makeRun({
    args: ['exec', '--json'],
    events: [],
    status: { stopped_on_deadline: true, elapsed_ms: 10 },
  });
  fs.rmSync(path.join(dir, 'stderr.log'));

  assert.match(transportGap(dir), /deadline watch/);
});
