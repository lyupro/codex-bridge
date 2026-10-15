/** Guards Plan_80 S1/E10/A4 receipt diagnostics without changing stdout or run decisions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { runCodex } from '../../src/home/lib/runner/codex-cmd.mjs';
import { MAX_LOG } from '../../src/home/lib/runner/git-state.mjs';
import { createStdoutReceipts } from '../../src/home/lib/runner/stdout-receipts.mjs';

const FIRST = '2026-10-15T10:00:00.000Z';
const SECOND = '2026-10-15T10:00:01.000Z';
const FINISH = '2026-10-15T10:00:09.000Z';

function fixture(t) {
  const root = makeTempTree('stdout-receipts-');
  t.after(() => removeTempTree(root));
  return root;
}

function clock(t) {
  const RealDate = Date;
  let now = FIRST;
  t.mock.method(globalThis, 'Date', class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return RealDate.parse(now); }
  });
  t.mock.method(Date, 'now', () => RealDate.parse(now));
  return (value) => { now = value; };
}

function fakeCodex(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const kills = [];
  child.kill = (...args) => { kills.push(args); };
  t.mock.method(childProcess, 'spawn', () => child);
  t.mock.method(childProcess, 'spawnSync', (...args) => {
    kills.push(args);
    return { status: 0 };
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { child, kills };
}

async function finish(child, result, code = 23) {
  child.stdout.end();
  child.stderr.end();
  child.emit('exit', code);
  child.emit('close', code);
  return result;
}

const readReceipts = (root) => fs.readFileSync(path.join(root, 'stdout-receipts.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('a split line receives the completing chunk time, not its first byte time', async (t) => {
  const root = fixture(t);
  const setTime = clock(t);
  const { child } = fakeCodex(t);
  const events = path.join(root, 'events.jsonl');
  const result = runCodex([], 'fixture', events, 1);
  child.stdout.write(Buffer.from('split '));
  setTime(SECOND);
  child.stdout.write(Buffer.from('line\n'));
  setTime(FINISH);
  const run = await finish(child, result);
  assert.deepEqual(readReceipts(root), [
    { seq: 1, offset: 0, bytes: 11, received_at: SECOND },
  ]);
  assert.equal(fs.readFileSync(events, 'utf8'), 'split line\n');
  assert.deepEqual(run.receipts, {
    lines: 1, last_received_at: SECOND, incomplete: false, truncated: false, write_error: null,
  });
});

test('two lines in one chunk share a time and use consecutive byte positions', async (t) => {
  const root = fixture(t);
  clock(t);
  const { child } = fakeCodex(t);
  const events = path.join(root, 'events.jsonl');
  const result = runCodex([], 'fixture', events, 1);
  const first = Buffer.from('é\r\n');
  const second = Buffer.from('😀\n');
  child.stdout.write(Buffer.concat([first, second]));
  const run = await finish(child, result);
  assert.deepEqual(readReceipts(root), [
    { seq: 1, offset: 0, bytes: first.length, received_at: FIRST },
    { seq: 2, offset: first.length, bytes: second.length, received_at: FIRST },
  ]);
  assert.deepEqual(fs.readFileSync(events), Buffer.concat([first, second]));
  assert.equal(run.receipts.lines, 2);
});

test('a trailing fragment keeps its last nonempty chunk time through finish', async (t) => {
  const root = fixture(t);
  const setTime = clock(t);
  const { child } = fakeCodex(t);
  const events = path.join(root, 'events.jsonl');
  const result = runCodex([], 'fixture', events, 1);
  child.stdout.write('ok\npar');
  setTime(SECOND);
  child.stdout.write('tial');
  setTime(FINISH);
  child.stdout.emit('data', Buffer.alloc(0));
  const run = await finish(child, result);
  assert.deepEqual(readReceipts(root), [
    { seq: 1, offset: 0, bytes: 3, received_at: FIRST },
    { seq: 2, offset: 3, bytes: 7, received_at: SECOND, incomplete: true },
  ]);
  assert.equal(fs.readFileSync(events, 'utf8'), 'ok\npartial');
  assert.deepEqual(run.receipts, {
    lines: 2, last_received_at: SECOND, incomplete: true, truncated: false, write_error: null,
  });
});

for (const newline of [true, false]) {
  test(`truncation of an oversized ${newline ? 'line' : 'fragment'} emits one terminal marker`, async (t) => {
    const root = fixture(t);
    const setTime = clock(t);
    const { child } = fakeCodex(t);
    const events = path.join(root, 'events.jsonl');
    const result = runCodex([], 'fixture', events, 1);
    child.stdout.write('ok\n');
    setTime(SECOND);
    child.stdout.write(Buffer.concat([Buffer.alloc(MAX_LOG, 0x78), Buffer.from(newline ? '\n' : '')]));
    setTime(FINISH);
    child.stdout.write('ignored\n');
    const run = await finish(child, result);
    assert.deepEqual(readReceipts(root), [
      { seq: 1, offset: 0, bytes: 3, received_at: FIRST },
      { truncated: true, received_at: SECOND, written_bytes: 3 },
    ]);
    assert.equal(fs.readFileSync(events, 'utf8'), 'ok\n');
    assert.deepEqual(run.receipts, {
      lines: 1, last_received_at: SECOND, incomplete: false, truncated: true, write_error: null,
    });
  });
}

test('a line exactly at MAX_LOG is retained before the next byte triggers truncation', async (t) => {
  const root = fixture(t);
  const setTime = clock(t);
  const { child } = fakeCodex(t);
  const events = path.join(root, 'events.jsonl');
  const result = runCodex([], 'fixture', events, 1);
  const line = Buffer.alloc(MAX_LOG, 0x78);
  line[MAX_LOG - 1] = 0x0a;
  child.stdout.write(line);
  setTime(SECOND);
  child.stdout.write('x');
  await finish(child, result);
  assert.deepEqual(fs.readFileSync(events), line);
  assert.deepEqual(readReceipts(root), [
    { seq: 1, offset: 0, bytes: MAX_LOG, received_at: FIRST },
    { truncated: true, received_at: SECOND, written_bytes: MAX_LOG },
  ]);
});

test('an unopenable receipts file leaves events and the run result intact', async (t) => {
  const root = fixture(t);
  clock(t);
  const { child, kills } = fakeCodex(t);
  fs.mkdirSync(path.join(root, 'stdout-receipts.jsonl'));
  const events = path.join(root, 'events.jsonl');
  const result = runCodex([], 'fixture', events, 1);
  // Wait for the actual failed open before testing output that follows the failure.
  await new Promise((resolve) => setTimeout(resolve, 25));
  child.stdout.write('still running\n');
  const run = await finish(child, result);
  assert.equal(fs.readFileSync(events, 'utf8'), 'still running\n');
  assert.deepEqual(kills, []);
  assert.equal(run.exit, 23);
  assert.equal(run.stoppedOnDeadline, false);
  assert.equal(run.stdioDrained, true);
  assert.equal(run.elapsedMs, 0);
  assert.equal(run.receipts.lines, 1);
  assert.match(run.receipts.write_error, /EISDIR|EPERM|EACCES/);
  assert.equal(fs.readFileSync(path.join(root, 'stderr.log'), 'utf8'),
    `run-codex: cannot write stdout-receipts.jsonl: ${run.receipts.write_error}\n`);
});

for (const stage of ['write', 'final']) {
  test(`a receipts ${stage} error is logged once before stderr closes and does not stop Codex`, async (t) => {
    const root = fixture(t);
    const { child, kills } = fakeCodex(t);
    const realCreate = fs.createWriteStream;
    let attempts = 0;
    t.mock.method(fs, 'createWriteStream', (file, options) => {
      if (path.basename(file) !== 'stdout-receipts.jsonl') return realCreate(file, options);
      return new Writable({
        write(_chunk, _encoding, callback) {
          attempts += 1;
          callback(stage === 'write' ? new Error('receipt disk full') : null);
        },
        final(callback) { callback(stage === 'final' ? new Error('receipt close failed') : null); },
      });
    });
    const events = path.join(root, 'events.jsonl');
    const result = runCodex([], 'fixture', events, 1);
    child.stdout.write('first\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write('second\n');
    const run = await finish(child, result);
    assert.equal(run.exit, 23);
    assert.equal(run.stoppedOnDeadline, false);
    assert.equal(run.stdioDrained, true);
    assert.deepEqual(kills, []);
    assert.equal(attempts, stage === 'write' ? 1 : 2);
    assert.equal(fs.readFileSync(events, 'utf8'), 'first\nsecond\n');
    assert.equal(fs.readFileSync(path.join(root, 'stderr.log'), 'utf8'),
      `run-codex: cannot write stdout-receipts.jsonl: ${run.receipts.write_error}\n`);
    assert.equal(run.receipts.write_error, stage === 'write' ? 'receipt disk full' : 'receipt close failed');
  });
}

test('events bytes are identical with and without writable receipts, including split UTF-8', async (t) => {
  const root = fixture(t);
  const { child, kills } = fakeCodex(t);
  const bytes = Buffer.from('é\r\n\n😀\nfragment');
  const chunks = [bytes.subarray(0, 1), bytes.subarray(1, 7), bytes.subarray(7)];
  const outputs = [];
  for (const enabled of [true, false]) {
    const dir = path.join(root, String(enabled));
    fs.mkdirSync(dir);
    if (!enabled) fs.mkdirSync(path.join(dir, 'stdout-receipts.jsonl'));
    const result = runCodex([], 'fixture', path.join(dir, 'events.jsonl'), 1);
    for (const chunk of chunks) child.stdout.emit('data', chunk);
    child.emit('exit', 23);
    child.emit('close', 23);
    const run = await result;
    outputs.push(fs.readFileSync(path.join(dir, 'events.jsonl')));
    assert.equal(run.exit, 23);
    child.removeAllListeners();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    assert.equal(run.receipts.write_error === null, enabled);
  }
  assert.deepEqual(outputs[0], bytes);
  assert.deepEqual(outputs[1], outputs[0]);
  assert.deepEqual(kills, []);
});

test('the receipt recorder ignores all records after truncation or close', async (t) => {
  const root = fixture(t);
  const errors = [];
  const receipts = createStdoutReceipts(root, (note) => errors.push(note));
  receipts.recordTruncation(FIRST, 0);
  receipts.recordLine(0, 2, SECOND);
  receipts.recordFragment(0, 1, SECOND);
  receipts.recordTruncation(SECOND, 99);
  await receipts.close();
  receipts.recordLine(0, 2, FINISH);
  await receipts.close();
  assert.deepEqual(readReceipts(root), [{ truncated: true, received_at: FIRST, written_bytes: 0 }]);
  assert.deepEqual(receipts.summary, {
    lines: 0, last_received_at: FIRST, incomplete: false, truncated: true, write_error: null,
  });
  assert.deepEqual(errors, []);
});
