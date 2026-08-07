/** Verifies sibling-run visibility, shared liveness semantics, and the state budget. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GUARD = path.join(ROOT, 'src', 'hooks', 'reply-guard.mjs');

function runGuard(root, reply, agentId = 'test-reply-guard') {
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      agent_type: 'codex-build',
      agent_id: agentId,
      last_assistant_message: reply,
    }),
    encoding: 'utf8',
    env: { ...process.env, HOME: root, USERPROFILE: root },
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-reply-guard-'));
  const runs = path.join(root, 'runs', 'project');
  await fs.mkdir(runs, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, runs };
}

async function createRun(runs, name, status, meta = null) {
  const dir = path.join(runs, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'status.json'), `${JSON.stringify(status)}\n`);
  if (meta) await fs.writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(meta)}\n`);
  return dir;
}

function ownStatus(slug = 'own-run') {
  return {
    state: 'finished',
    pid: process.pid,
    agent: 'codex-build',
    slug,
    repo: path.resolve('repository'),
    started_at: '2026-08-05T10:00:00.000Z',
  };
}

function replyFor(runDir, extra = '') {
  return `RUN=${runDir}\nOK — run finished.${extra}`;
}

test('an invented reply without any run folder is fail-closed', async (t) => {
  const { root } = await fixture(t);
  const result = runGuard(root, 'OK — files were created.');
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /no RUN= or ATTACH=/);
  assert.match(decision.reason, /prohibited/);
});

test('a reply that names every live run passes', async (t) => {
  const { root, runs } = await fixture(t);
  const own = await createRun(runs, 'own', ownStatus(), { status: 'OK' });
  // A writing sibling, so the test proves the reply's ATTACH= line is what clears it — a reader
  // would pass this case without naming anything at all.
  const sibling = await createRun(runs, 'sibling', {
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    slug: 'sibling-build',
    repo: path.resolve('repository'),
    started_at: '2026-08-05T10:01:00.000Z',
  });
  const result = runGuard(root, replyFor(own, `\nATTACH=${sibling} started=2026-08-05T10:01:00.000Z`));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('a reply silent about a live writing sibling is blocked with status facts', async (t) => {
  const { root, runs } = await fixture(t);
  const own = await createRun(runs, 'own', ownStatus(), { status: 'OK' });
  const sibling = await createRun(runs, 'sibling', {
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    slug: 'build-sibling',
    repo: path.resolve('repository'),
    started_at: '2026-08-05T10:01:00.000Z',
  });
  const result = runGuard(root, replyFor(own));
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, new RegExp(sibling.replaceAll('\\', '\\\\')));
  assert.match(decision.reason, /codex-build/);
  assert.match(decision.reason, /build-sibling/);
  assert.match(decision.reason, new RegExp(path.resolve('repository').replaceAll('\\', '\\\\')));
});

// Running scout and review beside other work is deliberate practice, not an accident: they hold
// a read-only sandbox and cannot touch the worktree. Blocking a reply over one would spend the
// state budget — and eventually the session — on a run that threatens nothing.
for (const reader of ['codex-scout', 'codex-review']) {
  test(`an unnamed live ${reader} sibling does not block: it cannot touch the tree`, async (t) => {
    const { root, runs } = await fixture(t);
    const own = await createRun(runs, 'own', ownStatus(), { status: 'OK' });
    await createRun(runs, `${reader}-sibling`, {
      state: 'running',
      pid: process.pid,
      agent: reader,
      slug: `${reader}-sibling`,
      repo: path.resolve('repository'),
      started_at: '2026-08-05T10:01:00.000Z',
    });
    const result = runGuard(root, replyFor(own));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });
}

test('a running sibling with a dead pid does not block', async (t) => {
  const { root, runs } = await fixture(t);
  const own = await createRun(runs, 'own', ownStatus(), { status: 'OK' });
  await createRun(runs, 'dead', {
    state: 'running',
    pid: Number.MAX_SAFE_INTEGER,
    agent: 'codex-build',
    slug: 'dead-sibling',
    repo: path.resolve('repository'),
    started_at: '2026-08-05T10:01:00.000Z',
  });
  const result = runGuard(root, replyFor(own));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('a finished sibling does not block', async (t) => {
  const { root, runs } = await fixture(t);
  const own = await createRun(runs, 'own', ownStatus(), { status: 'OK' });
  await createRun(runs, 'finished', {
    ...ownStatus('finished-sibling'),
    state: 'finished',
  }, { status: 'OK' });
  const result = runGuard(root, replyFor(own));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('sibling blocks spend the STATE budget and then end the turn', async (t) => {
  const { root, runs } = await fixture(t);
  const own = await createRun(runs, 'own', ownStatus(), { status: 'OK' });
  await createRun(runs, 'sibling', {
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    slug: 'budget-sibling',
    repo: path.resolve('repository'),
    started_at: '2026-08-05T10:01:00.000Z',
  });
  const results = [1, 2, 3, 4].map(() => runGuard(root, replyFor(own), 'budget-agent'));
  for (const result of results.slice(0, 3)) assert.equal(JSON.parse(result.stdout).decision, 'block');
  const exhausted = JSON.parse(results[3].stdout);
  assert.equal(exhausted.continue, false);
  assert.match(exhausted.stopReason, /budget-sibling/);
  assert.match(exhausted.stopReason, /codex-build/);
});

test('an unreadable sibling status is fail-open', async (t) => {
  const { root, runs } = await fixture(t);
  const own = await createRun(runs, 'own', ownStatus(), { status: 'OK' });
  const sibling = path.join(runs, 'broken');
  await fs.mkdir(sibling, { recursive: true });
  await fs.writeFile(path.join(sibling, 'status.json'), '{ broken');
  const result = runGuard(root, replyFor(own));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
