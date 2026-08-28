/** Verifies sibling-run visibility, shared liveness semantics, and the state budget. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GUARD = path.join(ROOT, 'src', 'home', 'hooks', 'reply-guard.mjs');

function runGuard(root, reply, agentId = 'test-reply-guard', transcriptPath = undefined) {
  const repo = path.join(root, 'project');
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      agent_type: 'codex-build',
      agent_id: agentId,
      agent_transcript_path: transcriptPath,
      cwd: repo,
      last_assistant_message: reply,
    }),
    encoding: 'utf8',
    env: { ...process.env, CODEX_RUNS_ROOT: path.join(root, 'runs'), HOME: root, USERPROFILE: root },
  });
}

async function writeTranscript(root, promptText, name = 'transcript.jsonl') {
  const transcriptPath = path.join(root, name);
  await fs.writeFile(transcriptPath, `${JSON.stringify({ message: { content: promptText } })}\n`);
  return transcriptPath;
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

test('an invented reply without any run folder is fail-closed', async (t) => {
  const { root } = await fixture(t);
  const result = runGuard(root, 'OK — files were created.');
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /no RUN= or ATTACH=/);
  assert.match(decision.reason, /prohibited/);
});

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
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  await assert.rejects(
    fs.access(path.join(root, '.claude', 'logs', 'codex-reply-guard.blocked.json')),
    { code: 'ENOENT' },
  );
});

test('a host refusal without its order id is blocked with the missing contract part', async (t) => {
  const { root } = await fixture(t);
  const result = runGuard(
    root,
    'FAIL — permission to run the command was denied. Run `codex-bridge install`.',
    'host-refusal-without-order',
  );
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.equal(
    decision.reason,
    'Contract violated: the host-refusal reply is missing the order id the orchestrator issued.',
  );
});

/**
 * The runner refuses before it creates a folder — a repeat without `--continue`, an impossible
 * `--scope`, a missing `--question` — and quoting that refusal is the whole honest answer. The
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
  const refusal = 'run-codex: --continue is required: runs for task "x" already exist in this '
    + 'repository (1). The run folder was not created; quota was not spent.';

  // One agent id across all four calls: the budget is per agent, and the fourth try is the point.
  const decisions = [1, 2, 3, 4].map(() => runGuard(root, refusal, 'refusal-budget'));

  for (const result of decisions.slice(0, 3)) {
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /refused before creating a folder/);
    assert.equal(decision.continue, undefined, 'a truthful refusal must never end the session');
  }
  assert.equal(decisions[3].stdout, '', 'the soft budget must let a truthful refusal through');
});

test('a folderless FAIL is blocked by a recent finished OK run found on disk', async (t) => {
  const { root, runs } = await fixture(t);
  const finishedAt = new Date().toISOString();
  const run = await createRun(runs, 'recent-ok', {
    ...ownStatus('recent-ok'),
    finished_at: finishedAt,
    status: 'OK',
  }, { status: 'OK', reason: 'artifacts are complete', finished_at: finishedAt });
  const result = runGuard(root, 'FAIL — invented dispatcher verdict.');
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, new RegExp(run.replaceAll('\\', '\\\\')));
  assert.match(decision.reason, /state=finished/);
  assert.match(decision.reason, /status=OK in meta\.json/);
});

test('a folderless reply with no recent matching run keeps the missing-run block', async (t) => {
  const { root } = await fixture(t);
  const result = runGuard(root, 'FAIL — invented dispatcher verdict.', 'no-recent-run');
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /no recent run/);
});

test('folderless reply blocks spend STATE budget and then end the turn', async (t) => {
  const { root } = await fixture(t);
  const results = [1, 2, 3, 4].map(() => runGuard(root, 'FAIL — invented dispatcher verdict.', 'missing-budget'));
  for (const result of results.slice(0, 3)) assert.equal(JSON.parse(result.stdout).decision, 'block');
  const exhausted = JSON.parse(results[3].stdout);
  assert.equal(exhausted.continue, false);
  assert.match(exhausted.stopReason, /no recent matching run was found on disk/);
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
  const result = runGuard(root, 'FAIL — invented dispatcher verdict.', 'wrong-candidates');
  const decision = JSON.parse(result.stdout);
  assert.match(decision.reason, /no recent run/);
  assert.doesNotMatch(decision.reason, new RegExp(other.replaceAll('\\', '\\\\')));
  assert.doesNotMatch(decision.reason, new RegExp(old.replaceAll('\\', '\\\\')));
});

test('folderless lookup does not create a project directory or marker', async (t) => {
  const root = makeTempTree('bridge-reply-guard-no-create-');
  t.after(() => removeTempTree(root));
  const result = runGuard(root, 'FAIL — invented dispatcher verdict.', 'no-create');
  assert.equal(JSON.parse(result.stdout).decision, 'block');
  await assert.rejects(fs.access(path.join(root, 'runs')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'runs', 'project', '.project.json')), { code: 'ENOENT' });
});

test('folderless lookup is fail-open when a status file is broken', async (t) => {
  const { root, runs } = await fixture(t);
  const broken = path.join(runs, 'broken-recent');
  await fs.mkdir(broken);
  await fs.writeFile(path.join(broken, 'status.json'), '{ broken');
  const result = runGuard(root, 'FAIL — invented dispatcher verdict.', 'broken-disk');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('folderless lookup is fail-open when the project candidate is not a directory', async (t) => {
  const root = makeTempTree('bridge-reply-guard-unavailable-');
  t.after(() => removeTempTree(root));
  await fs.mkdir(path.join(root, 'runs'));
  await fs.writeFile(path.join(root, 'runs', 'project'), 'unavailable');
  const result = runGuard(root, 'FAIL — invented dispatcher verdict.', 'unavailable-disk');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
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
    process_started_at: performance.timeOrigin,
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
      process_started_at: performance.timeOrigin,
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
    process_started_at: performance.timeOrigin,
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
    process_started_at: performance.timeOrigin,
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

test('a reply naming a run from another order is blocked as external state', async (t) => {
  const { root, runs } = await fixture(t);
  const run = await createRun(runs, 'wrong-order', {
    ...ownStatus('wrong-order'),
    order_id: 'run-two-order',
  }, { status: 'OK' });
  const transcriptPath = await writeTranscript(root, 'order id: run-three-order\ntask file: C:/task.md');
  const result = runGuard(root, replyFor(run), 'wrong-order-agent', transcriptPath);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /run-three-order/);
  assert.match(decision.reason, /run-two-order/);
  assert.match(decision.reason, new RegExp(run.replaceAll('\\', '\\\\')));
  assert.match(decision.reason, /Run the ordered order id/);
  assert.match(decision.reason, /return that run's stdout verbatim/);
});

test('a reply naming the ordered run passes', async (t) => {
  const { root, runs } = await fixture(t);
  const run = await createRun(runs, 'matching-order', {
    ...ownStatus('matching-order'),
    order_id: 'matching-order-id',
  }, { status: 'OK' });
  const transcriptPath = await writeTranscript(root, 'order id: matching-order-id\ntask file: C:/task.md');
  const result = runGuard(root, replyFor(run), 'matching-order-agent', transcriptPath);
  assert.equal(result.stdout, '');
});

test('missing or malformed transcripts do not block an otherwise valid reply', async (t) => {
  const { root, runs } = await fixture(t);
  const run = await createRun(runs, 'diagnostic-only', {
    ...ownStatus('diagnostic-only'),
    order_id: 'stored-order',
  }, { status: 'OK' });
  const missing = runGuard(root, replyFor(run), 'missing-transcript', path.join(root, 'missing.jsonl'));
  assert.equal(missing.stdout, '');

  const malformedPath = path.join(root, 'malformed.jsonl');
  await fs.writeFile(malformedPath, '{ malformed\n');
  const malformed = runGuard(root, replyFor(run), 'malformed-transcript', malformedPath);
  assert.equal(malformed.stdout, '');
});
