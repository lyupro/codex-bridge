/** Verifies prune execution guards, four scopes, reports, and chain survivability. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prune } from '../../cli/prune.mjs';
import { chainRuns } from '../../src/meta/chain.mjs';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');
const TRANSPORT = ['events.jsonl', 'stderr.log', 'raw.log'];
const KEEP = ['meta.json', 'report.md', 'result.json', 'state-before.txt', 'state-after.txt', 'git-before.txt', 'git-after.txt', 'diff.stat', 'status.json', 'worker.json', 'schema.json', 'task.md', 'reply.txt'];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeRun(root, project, run, extra = {}) {
  const dir = path.join(root, project, run);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of TRANSPORT) fs.writeFileSync(path.join(dir, name), `${name}\n`);
  for (const name of KEEP) fs.writeFileSync(path.join(dir, name), `${name}\n`);
  for (const [name, value] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), value);
  return dir;
}

function options(root, prompt = () => true) {
  return { runsRootPath: root, now: NOW, isTTY: true, prompt };
}

function assertGentleResult(dir, result) {
  assert.equal(result.exitCode, 0);
  for (const name of TRANSPORT) assert.equal(fs.existsSync(path.join(dir, name)), false, name);
  for (const name of KEEP) assert.equal(fs.existsSync(path.join(dir, name)), true, name);
  assert.match(result.output, /Space freed:/);
}

test('single-run gentle prune removes transport only and returns success', async (t) => {
  const root = fixture(t);
  const run = '2026-07-01_090000_single';
  const dir = makeRun(root, 'alpha', run);

  const result = await prune(['alpha', run, '--force'], options(root));

  assertGentleResult(dir, result);
});

test('single-run purge removes the entire run folder', async (t) => {
  const root = fixture(t);
  const run = 'manual-run';
  const dir = makeRun(root, 'alpha', run);

  const result = await prune(['alpha', run, '--purge', '-f'], options(root));

  assert.equal(result.exitCode, 0);
  assert.equal(fs.existsSync(dir), false);
  assert.match(result.output, new RegExp(dir.replaceAll('\\', '\\\\')));
});

test('whole-project gentle prune visits every old run and leaves project folders', async (t) => {
  const root = fixture(t);
  const first = makeRun(root, 'alpha', '2026-07-01_090000_first');
  const second = makeRun(root, 'alpha', '2026-07-02_090000_second');

  const result = await prune(['alpha', '-f'], options(root));

  assertGentleResult(first, result);
  for (const name of TRANSPORT) assert.equal(fs.existsSync(path.join(second, name)), false, name);
  assert.equal(fs.existsSync(path.join(root, 'alpha')), true);
});

test('whole-project purge removes the project folder', async (t) => {
  const root = fixture(t);
  makeRun(root, 'alpha', '2026-07-01_090000_old');

  const result = await prune(['alpha', '--purge', '--force'], options(root));

  assert.equal(result.exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, 'alpha')), false);
});

test('all-projects gently removes old transport without accepting purge', async (t) => {
  const root = fixture(t);
  const alpha = makeRun(root, 'alpha', '2026-07-01_090000_old');
  const beta = makeRun(root, 'beta', '2026-07-01_090001_old');

  const result = await prune(['--all-projects', '--force'], options(root));

  assertGentleResult(alpha, result);
  for (const name of TRANSPORT) assert.equal(fs.existsSync(path.join(beta, name)), false, name);
  assert.equal(fs.existsSync(path.join(root, 'alpha')), true);
  assert.equal(fs.existsSync(path.join(root, 'beta')), true);
});

test('dry run and force execution name the same targets', async (t) => {
  const root = fixture(t);
  const run = '2026-07-01_090000_agreement';
  const dir = makeRun(root, 'alpha', run);

  const dry = await prune(['alpha', run], options(root));
  assert.equal(dry.exitCode, 0);
  assert.match(dry.output, /Nothing was deleted/);
  for (const name of TRANSPORT) {
    const target = path.join(dir, name);
    assert.equal(fs.existsSync(target), true);
    assert.match(dry.output, new RegExp(target.replaceAll('\\', '\\\\')));
  }

  const forced = await prune(['alpha', run, '-f'], options(root));
  assert.equal(forced.exitCode, 0);
  for (const name of TRANSPORT) {
    const target = path.join(dir, name);
    assert.match(forced.output, new RegExp(target.replaceAll('\\', '\\\\')));
    assert.equal(fs.existsSync(target), false);
  }
});

test('declined confirmation deletes nothing', async (t) => {
  const root = fixture(t);
  const dir = makeRun(root, 'alpha', '2026-07-01_090000_declined');

  const result = await prune(['alpha', '2026-07-01_090000_declined', '-f'], options(root, () => false));

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /no files were deleted/);
  for (const name of [...TRANSPORT, ...KEEP]) assert.equal(fs.existsSync(path.join(dir, name)), true, name);
});

test('no TTY refuses regardless of force and never calls the prompt', async (t) => {
  const root = fixture(t);
  const dir = makeRun(root, 'alpha', '2026-07-01_090000_no-tty');
  let prompted = false;

  const result = await prune(['alpha', '2026-07-01_090000_no-tty', '--force'], {
    ...options(root),
    isTTY: false,
    prompt: () => { prompted = true; return true; },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /No TTY/);
  assert.match(result.output, /deletion is an operator action/);
  assert.equal(prompted, false);
  for (const name of TRANSPORT) assert.equal(fs.existsSync(path.join(dir, name)), true, name);
});

test('all-projects purge is refused in code before deletion', async (t) => {
  const root = fixture(t);
  const dir = makeRun(root, 'alpha', '2026-07-01_090000_refused');

  const result = await prune(['--all-projects', '--purge', '--force'], options(root));

  assert.equal(result.exitCode, 2);
  assert.match(result.output, /cannot be combined with --purge/);
  assert.equal(fs.existsSync(dir), true);
});

test('gentle prune leaves the run chain and tree snapshots readable', async (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'repo');
  const first = '2026-07-01_090000_chain';
  const second = '2026-07-02_090000_chain';
  for (const [run, started] of [[first, '2026-07-01T09:00:00.000Z'], [second, '2026-07-02T09:00:00.000Z']]) {
    makeRun(root, 'alpha', run, {
      'status.json': JSON.stringify({ repo, slug: 'chain', started_at: started }),
      'state-before.txt': `before-${run}`,
      'state-after.txt': `after-${run}`,
    });
  }
  const result = await prune(['alpha', '-f'], options(root));

  assert.equal(result.exitCode, 0);
  assert.deepEqual(chainRuns(path.join(root, 'alpha'), repo, 'chain'), [first, second]);
  assert.equal(fs.readFileSync(path.join(root, 'alpha', first, 'state-before.txt'), 'utf8'), `before-${first}`);
  assert.equal(fs.readFileSync(path.join(root, 'alpha', second, 'state-after.txt'), 'utf8'), `after-${second}`);
});

test('--json returns a machine-readable plan and report', async (t) => {
  const root = fixture(t);
  const run = '2026-07-01_090000_json';
  const dir = makeRun(root, 'alpha', run);

  const plan = await prune(['alpha', run, '--json'], options(root));
  const forced = await prune(['alpha', run, '--json', '--force'], options(root));

  assert.equal(JSON.parse(plan.output).status, 'plan');
  assert.equal(JSON.parse(forced.output).status, 'completed');
  assert.deepEqual(JSON.parse(forced.output).removed, TRANSPORT.map((name) => path.join(dir, name)));
});
