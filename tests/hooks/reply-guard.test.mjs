/** Verifies sibling-run visibility, shared liveness semantics, and the state budget. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateDispatcherState } from '../../src/home/lib/dispatcher-state.mjs';
import { noReceiptReason } from '../../src/home/hooks/reply-verdicts.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GUARD = path.join(ROOT, 'src', 'home', 'hooks', 'reply-guard.mjs');

function runGuard(root, reply, agentId = 'test-reply-guard', transcriptPath = undefined, sessionId = undefined) {
  const repo = path.join(root, 'project');
  // raw argv: the hook receives its event on stdin, not a runner order.
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      agent_type: 'codex-build',
      agent_id: agentId,
      session_id: sessionId,
      agent_transcript_path: transcriptPath,
      cwd: repo,
      last_assistant_message: reply,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_RUNS_ROOT: path.join(root, 'runs'),
      HOME: root,
      USERPROFILE: root,
      CODEX_BRIDGE_HOME: path.join(root, '.lyupro', '.codex-bridge'),
    },
  });
}

async function seedReceipt(root, runReceipt, agentId = 'test-reply-guard') {
  const bridgeHome = path.join(root, '.lyupro', '.codex-bridge');
  const previousHome = process.env.CODEX_BRIDGE_HOME;
  process.env.CODEX_BRIDGE_HOME = bridgeHome;
  const moduleUrl = new URL('../../src/home/lib/brand-home.mjs', import.meta.url);
  moduleUrl.searchParams.set('test-home', bridgeHome);
  let stateDir;
  try {
    ({ BRAND_STATE_DIR: stateDir } = await import(moduleUrl.href));
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_BRIDGE_HOME;
    else process.env.CODEX_BRIDGE_HOME = previousHome;
  }
  const sessionId = 'receipt-session';
  await updateDispatcherState({ stateDir, sessionId, agentId }, (current) => ({ ...current, runReceipt }));
  return sessionId;
}

async function fixture(t) {
  const root = makeTempTree('bridge-reply-guard-');
  const runs = path.join(root, 'runs', 'project');
  await fs.mkdir(runs, { recursive: true });
  await fs.writeFile(path.join(runs, '.project.json'), `${JSON.stringify({ repo: path.join(root, 'project') })}\n`);
  t.after(() => removeTempTree(root));
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
    process_started_at: performance.timeOrigin,
  };
}

function replyFor(runDir, extra = '') {
  return `RUN=${runDir}\nOK — run finished.${extra}`;
}

/**
 * The 2026-08-16 live permission-denial probe proved an honest host refusal was indistinguishable
 * from skipped delegation and spent three state tries. A complete refusal is terminal evidence,
 * so it must pass before any form or state budget is touched.
 */
test('a complete host refusal passes immediately without spending try budget', async (t) => {
  const { root } = await fixture(t);
  const result = runGuard(
    root,
    'FAIL — host denied order id `probe-refusal`. Run `codex-bridge install` to grant permission.',
    'complete-host-refusal',
    undefined, 'receipt-session',
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  await assert.rejects(
    fs.access(path.join(root, '.lyupro', '.codex-bridge', 'state', 'reply-guard-tries.json')),
    { code: 'ENOENT' },
  );
});

test('a host refusal without its order id is blocked with the missing contract part', async (t) => {
  const { root } = await fixture(t);
  const result = runGuard(
    root,
    'FAIL — permission to run the command was denied. Run `codex-bridge install`.',
    'host-refusal-without-order',
    undefined, 'receipt-session',
  );
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.equal(
    decision.reason,
    'Contract violated: the host-refusal reply is missing the order id the orchestrator issued.',
  );
});

/**
 * The runner refuses before it creates a folder — a repeat without a grant, an impossible
 * `scope:`, missing questions — and quoting that refusal is the whole honest answer. The
 * first version of the disk search escalated it anyway: it found an unrelated recent run and
 * demanded the dispatcher name that folder, which after three tries would have ended the session
 * over a reply that was true. A reply pronouncing no verdict contradicts nothing.
 */
test('a quoted runner refusal is not escalated by an unrelated recent run', async (t) => {
  const { root, runs } = await fixture(t);
  await createRun(runs, 'unrelated-ok', {
    ...ownStatus('unrelated-ok'),
    finished_at: new Date().toISOString(),
    status: 'OK',
  }, { status: 'OK', reason: null });
  const refusal = 'run-codex: `continue:` is required: runs for task "x" already exist in this '
    + 'repository (1). The run folder was not created; quota was not spent.';

  // One agent id across all four calls: the budget is per agent, and the fourth try is the point.
  const decisions = [1, 2, 3, 4].map(() => runGuard(root, refusal, 'refusal-budget', undefined, 'receipt-session'));

  for (const result of decisions.slice(0, 3)) {
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /refused before creating a folder/);
    assert.equal(decision.continue, undefined, 'a truthful refusal must never end the session');
  }
  assert.equal(decisions[3].stdout, '', 'the soft budget must let a truthful refusal through');
});

test('a folderless FAIL is blocked by its receipted finished OK run', async (t) => {
  const { root, runs } = await fixture(t);
  const finishedAt = new Date().toISOString();
  const run = await createRun(runs, 'recent-ok', {
    ...ownStatus('recent-ok'),
    finished_at: finishedAt,
    status: 'OK',
  }, { status: 'OK', reason: 'artifacts are complete', finished_at: finishedAt });
  const sessionId = await seedReceipt(root, run);
  const result = runGuard(root, 'FAIL — invented dispatcher verdict.', 'test-reply-guard', undefined, sessionId);
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, new RegExp(run.replaceAll('\\', '\\\\')));
  assert.match(decision.reason, /state=finished/);
  assert.match(decision.reason, /status=OK in meta\.json/);
});

test('a folderless verdict without a receipt is blocked', async (t) => {
  const { root } = await fixture(t);
  const result = runGuard(root, 'FAIL — invented dispatcher verdict.', 'no-recent-run', undefined, 'receipt-session');
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.equal(decision.reason, noReceiptReason);
});

test('folderless reply blocks spend STATE budget and then end the turn', async (t) => {
  const { root } = await fixture(t);
  const results = [1, 2, 3, 4].map(() => runGuard(root, 'FAIL — invented dispatcher verdict.', 'missing-budget', undefined, 'receipt-session'));
  for (const result of results.slice(0, 3)) assert.equal(JSON.parse(result.stdout).decision, 'block');
  const exhausted = JSON.parse(results[3].stdout);
  assert.equal(exhausted.continue, false);
  assert.match(exhausted.stopReason, /without a run receipt for agent codex-build/);
  assert.match(exhausted.stopReason, /answer was not checked/);
});

test('a folderless reply ignores runs from another agent and stale runs', async (t) => {
  const { root, runs } = await fixture(t);
  const stale = new Date(Date.now() - (25 * 60 * 60 * 1_000)).toISOString();
  const other = await createRun(runs, 'other-agent', {
    ...ownStatus('other-agent'),
    agent: 'codex-review',
    finished_at: new Date().toISOString(),
    status: 'OK',
  }, { status: 'OK' });
  const old = await createRun(runs, 'stale', {
    ...ownStatus('stale'),
    finished_at: stale,
    status: 'OK',
  }, { status: 'OK' });
  const result = runGuard(root, 'FAIL — invented dispatcher verdict.', 'wrong-candidates', undefined, 'receipt-session');
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.reason, noReceiptReason);
  assert.doesNotMatch(decision.reason, new RegExp(other.replaceAll('\\', '\\\\')));
  assert.doesNotMatch(decision.reason, new RegExp(old.replaceAll('\\', '\\\\')));
});

test('folderless lookup does not create a project directory or marker', async (t) => {
  const root = makeTempTree('bridge-reply-guard-no-create-');
  t.after(() => removeTempTree(root));
  const result = runGuard(root, 'FAIL — invented dispatcher verdict.', 'no-create', undefined, 'receipt-session');
  assert.equal(JSON.parse(result.stdout).decision, 'block');
  await assert.rejects(fs.access(path.join(root, 'runs')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'runs', 'project', '.project.json')), { code: 'ENOENT' });
});

test('a broken unrelated status file cannot bypass the no-receipt block', async (t) => {
  const { root, runs } = await fixture(t);
  const broken = path.join(runs, 'broken-recent');
  await fs.mkdir(broken);
  await fs.writeFile(path.join(broken, 'status.json'), '{ broken');
  const result = runGuard(root, 'FAIL — invented dispatcher verdict.', 'broken-disk', undefined, 'receipt-session');
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).reason, noReceiptReason);
});

test('an unavailable runs directory cannot bypass the no-receipt block', async (t) => {
  const root = makeTempTree('bridge-reply-guard-unavailable-');
  t.after(() => removeTempTree(root));
  await fs.mkdir(path.join(root, 'runs'));
  await fs.writeFile(path.join(root, 'runs', 'project'), 'unavailable');
  const result = runGuard(root, 'FAIL — invented dispatcher verdict.', 'unavailable-disk', undefined, 'receipt-session');
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).reason, noReceiptReason);
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
    process_started_at: performance.timeOrigin,
  });
  const sessionId = await seedReceipt(root, own);
  const result = runGuard(root, replyFor(own, `\nATTACH=${sibling} started=2026-08-05T10:01:00.000Z`), 'test-reply-guard', undefined, sessionId);
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
    process_started_at: performance.timeOrigin,
  });
  const sessionId = await seedReceipt(root, own);
  const result = runGuard(root, replyFor(own), 'test-reply-guard', undefined, sessionId);
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
for (const reader of ['codex-scout', 'codex-review', 'codex-advisor']) {
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
      process_started_at: performance.timeOrigin,
    });
    const sessionId = await seedReceipt(root, own);
    const result = runGuard(root, replyFor(own), 'test-reply-guard', undefined, sessionId);
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
    process_started_at: performance.timeOrigin,
  });
  const sessionId = await seedReceipt(root, own);
  const result = runGuard(root, replyFor(own), 'test-reply-guard', undefined, sessionId);
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
  const sessionId = await seedReceipt(root, own);
  const result = runGuard(root, replyFor(own), 'test-reply-guard', undefined, sessionId);
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
    process_started_at: performance.timeOrigin,
  });
  const sessionId = await seedReceipt(root, own, 'budget-agent');
  const results = [1, 2, 3, 4].map(() => runGuard(root, replyFor(own), 'budget-agent', undefined, sessionId));
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
  const sessionId = await seedReceipt(root, own);
  const result = runGuard(root, replyFor(own), 'test-reply-guard', undefined, sessionId);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
