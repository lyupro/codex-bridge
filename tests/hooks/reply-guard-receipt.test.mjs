/** Plan_63 D10: gate-receipt identity and host-id loss guards for the 2026-09-24 stranger-run incident. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateDispatcherState } from '../../src/home/lib/dispatcher-state.mjs';
import { decideReplyIdentity, missingIdsAlarm, readReceiptEvidence } from '../../src/home/hooks/reply-identity.mjs';
import {
  missingRunReason, noReceiptReason, nonexistentRunReason,
  receiptConflictReason, receiptMismatchReason,
} from '../../src/home/hooks/reply-verdicts.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const GUARD = path.resolve(fileURLToPath(new URL('../../src/home/hooks/reply-guard.mjs', import.meta.url)));
const SESSION_ID = 'receipt-session';
const AGENT_ID = 'receipt-dispatcher';
const MISSING_IDS_MESSAGE = 'codex-bridge: the host did not report session_id and agent_id for dispatcher codex-scout — whose run this answer quotes cannot be checked; run codex-bridge doctor.';

async function fixture(t, agentType = 'codex-scout', agentId = AGENT_ID) {
  const root = makeTempTree('bridge-reply-receipt-');
  t.after(() => removeTempTree(root));
  const bridgeHome = path.join(root, 'bridge-home');
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
  const runs = path.join(root, 'runs', 'project');
  await fs.mkdir(runs, { recursive: true });
  const seed = (state) => updateDispatcherState({ stateDir, sessionId: SESSION_ID, agentId },
    (current) => ({ ...current, ...state }));
  const guard = (reply, ids = {}, failStateRead = false) => {
    const args = failStateRead ? ['--input-type=module', '--eval', `
      import fs from 'node:fs';
      const read = fs.readFileSync;
      let injected = false;
      fs.readFileSync = (file, ...options) => {
        if (typeof file === 'string' && file.startsWith(${JSON.stringify(stateDir)})
          && !file.endsWith('reply-guard-tries.json')) {
          injected = true;
          throw new Error('injected dispatcher state read failure');
        }
        return read(file, ...options);
      };
      process.on('exit', () => { if (!injected) process.exitCode = 1; });
      await import(${JSON.stringify(new URL('../../src/home/hooks/reply-guard.mjs', import.meta.url).href)});
    `] : [GUARD];
    const result = spawnSync(process.execPath, args, {
      input: JSON.stringify({
        agent_type: agentType, session_id: SESSION_ID, agent_id: agentId,
        cwd: path.join(root, 'project'), last_assistant_message: reply, ...ids,
      }),
      encoding: 'utf8',
      env: { ...process.env, CODEX_BRIDGE_HOME: bridgeHome, CODEX_RUNS_ROOT: path.join(root, 'runs'),
        HOME: root, USERPROFILE: root },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : null;
  };
  return { root, runs, stateDir, seed, guard };
}

async function createRun(runs, name, status = {}, meta = { status: 'OK' }) {
  const dir = path.join(runs, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'status.json'), JSON.stringify({
    state: 'finished', status: 'OK', agent: 'codex-scout', slug: name,
    finished_at: new Date().toISOString(), ...status,
  }));
  if (meta) await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
}

test('a folderless verdict is judged against receipt R even when a newer run of the same agent exists', async (t) => {
  const { runs, seed, guard } = await fixture(t);
  const receipt = await createRun(runs, 'receipt-R', {
    finished_at: new Date(Date.now() - 2_000).toISOString(), status: 'FAIL',
  }, { status: 'FAIL', reason: 'receipted failure' });
  const stranger = await createRun(runs, 'newer-stranger');
  await seed({ runReceipt: receipt });
  const decision = guard('OK — invented verdict.');
  const identity = decideReplyIdentity({ runDir: null, hasIds: true, receipt, receiptConflict: null, agentType: 'codex-scout' });
  assert.equal(identity.runDir, receipt);
  assert.equal(identity.discoveredRun, true);
  assert.equal(identity.discoveredStatus.status, 'FAIL');
  assert.equal(decision.decision, 'block');
  assert.ok(decision.reason.includes(receipt));
  assert.match(decision.reason, /status=FAIL in meta\.json/);
  assert.ok(!decision.reason.includes(stranger));
});

test('a reply naming X while the receipt names R blocks naming both folders and exhausts STATE', async (t) => {
  const { runs, seed, guard } = await fixture(t);
  const receipt = await createRun(runs, 'receipt-R');
  const named = await createRun(runs, 'named-X');
  await seed({ runReceipt: receipt });
  for (let i = 0; i < 3; i += 1) {
    const decision = guard(`RUN=${named}\nOK — done.`);
    assert.equal(decision.decision, 'block');
    assert.equal(decision.reason, receiptMismatchReason(named, receipt));
  }
  const stop = guard(`RUN=${named}\nOK — done.`);
  assert.equal(stop.continue, false);
  for (const fact of ['codex-scout', receipt, named, 'answer was not checked']) assert.ok(stop.stopReason.includes(fact));
});

test('a conflicting state receipt blocks before judging either named or folderless verdicts', async (t) => {
  const { runs, seed, guard } = await fixture(t);
  const receipt = await createRun(runs, 'receipt-R');
  const conflict = await createRun(runs, 'conflict-X');
  await seed({ runReceipt: receipt, runReceiptConflict: conflict });
  const identity = decideReplyIdentity({ runDir: receipt, hasIds: true, receipt, receiptConflict: conflict, agentType: 'codex-scout' });
  assert.equal(identity.block.reason, receiptConflictReason(receipt, conflict));
  for (const reply of [`RUN=${receipt}\nOK — done.`, 'OK — done.', `RUN=${conflict}\nOK — done.`]) {
    const decision = guard(reply);
    assert.equal(decision.decision, 'block');
    assert.equal(decision.reason, receiptConflictReason(receipt, conflict));
  }
  const stop = guard('OK — done.');
  assert.equal(stop.continue, false);
  for (const fact of ['codex-scout', receipt, conflict, 'answer was not checked']) assert.ok(stop.stopReason.includes(fact));
});

test('ids with no receipt block named and folderless replies without naming a stranger', async (t) => {
  const { runs, guard } = await fixture(t);
  const stranger = await createRun(runs, 'stranger-recent');
  for (const reply of ['OK — done.', `RUN=${stranger}\nOK — done.`, 'FAIL — done.']) {
    const decision = guard(reply);
    assert.equal(decision.decision, 'block');
    assert.equal(decision.reason, noReceiptReason);
    assert.ok(!decision.reason.includes(stranger));
  }
  const stop = guard('OK — done.');
  assert.equal(stop.continue, false);
  assert.match(stop.stopReason, /codex-scout/);
  assert.match(stop.stopReason, /answer was not checked/);
  assert.ok(!stop.stopReason.includes(stranger));
});

test('a throwing state read retains host ids and blocks instead of searching disk', async (t) => {
  const { runs, seed, guard } = await fixture(t);
  const stranger = await createRun(runs, 'stranger-recent');
  await seed({ runReceipt: stranger });
  for (const reply of ['OK — done.', `RUN=${stranger}\nOK — done.`]) {
    const decision = guard(reply, {}, true);
    assert.equal(decision.decision, 'block');
    assert.equal(decision.reason, noReceiptReason);
    assert.ok(!decision.reason.includes(stranger));
  }
});

test('form checks precede conflicting receipts', async (t) => {
  const { root, seed, guard } = await fixture(t);
  await seed({ runReceipt: path.join(root, 'R'), runReceiptConflict: path.join(root, 'X') });
  assert.equal(guard(`RUN=${path.join(root, 'missing')}\nOK — done.`).reason, nonexistentRunReason);
  assert.equal(guard('The runner refused before creating a folder.').reason, missingRunReason);
  assert.equal(guard('No verdict was recorded.').reason, missingRunReason);
  assert.equal(guard('No verdict after form budget exhaustion.'), null);
});

test('matching receipts use normalizePath and ignore status and transcript order ids', async (t) => {
  const { root, runs, seed, guard } = await fixture(t);
  const receipt = await createRun(runs, 'receipt-R', { order_id: 'stored-order' });
  await seed({ runReceipt: receipt });
  const transcript = path.join(root, 'agent.jsonl');
  await fs.writeFile(transcript, JSON.stringify({
    type: 'user', message: { content: 'order id: different-order' },
  }) + '\n');
  const named = receipt.replaceAll('\\', '/') + '/';
  assert.deepEqual(decideReplyIdentity({ runDir: named, hasIds: true, receipt, receiptConflict: null, agentType: 'codex-scout' }),
    { runDir: named, discoveredRun: false, discoveredStatus: null });
  assert.equal(guard(`ATTACH=${named}\nOK — done.`, { agent_transcript_path: transcript }), null);
});

test('a folderless matching verdict still blocks an omitted receipted folder', async (t) => {
  const { runs, seed, guard } = await fixture(t);
  const receipt = await createRun(runs, 'receipt-R');
  await seed({ runReceipt: receipt });
  for (let i = 0; i < 3; i += 1) {
    const decision = guard('OK — done.');
    assert.equal(decision.decision, 'block');
    assert.ok(decision.reason.includes(`omitted RUN=${receipt}`));
  }
  const stop = guard('OK — done.');
  assert.equal(stop.continue, false);
  assert.ok(stop.stopReason.includes(receipt));
});

for (const statusText of [null, '{ broken', 'null']) {
  for (const claimed of ['OK', 'FAIL']) {
    test(`a receipted folder with status ${JSON.stringify(statusText)} still checks a ${claimed} verdict`, async (t) => {
      const { runs, seed, guard } = await fixture(t);
      const receipt = path.join(runs, 'receipt-without-status');
      await fs.mkdir(receipt);
      if (statusText !== null) await fs.writeFile(path.join(receipt, 'status.json'), statusText);
      await fs.writeFile(path.join(receipt, 'meta.json'), JSON.stringify({ status: 'OK' }));
      await seed({ runReceipt: receipt });
      assert.equal(decideReplyIdentity({ runDir: null, hasIds: true, receipt, receiptConflict: null, agentType: 'codex-scout' }).discoveredStatus, null);
      for (let i = 0; i < 3; i += 1) {
        const decision = guard(`${claimed} — done.`);
        assert.equal(decision.decision, 'block');
        assert.ok(decision.reason.includes(receipt));
        assert.match(decision.reason, /state=not recorded/);
        assert.match(decision.reason, claimed === 'OK' ? /omitted RUN=/ : /you reported FAIL/);
      }
      const stop = guard(`${claimed} — done.`);
      assert.equal(stop.continue, false);
      assert.ok(stop.stopReason.includes(receipt));
    });
  }
}

for (const [state, expected] of [
  ['running-live', /process is alive/], ['running-dead', /process with this pid is dead/],
  ['abandoned', /state=abandoned/], ['finished', /has no meta\.json/],
]) {
  test(`a folderless receipted ${state} run retains its external-state check`, async (t) => {
    const { runs, seed, guard } = await fixture(t);
    const receipt = await createRun(runs, state, {
      state: state.startsWith('running-') ? 'running' : state,
      pid: state === 'running-live' ? process.pid : Number.MAX_SAFE_INTEGER,
      process_started_at: performance.timeOrigin,
    }, null);
    await seed({ runReceipt: receipt });
    for (let i = 0; i < 3; i += 1) {
      const decision = guard('OK — done.');
      assert.equal(decision.decision, 'block');
      assert.match(decision.reason, expected);
    }
    const stop = guard('OK — done.');
    assert.equal(stop.continue, false);
    assert.ok(stop.stopReason.includes(receipt));
  });
}

test('a receipt to a nonexistent folder reaches the missing-meta state block', async (t) => {
  const { root, seed, guard } = await fixture(t);
  const receipt = path.join(root, 'missing-receipt-folder');
  await seed({ runReceipt: receipt });
  const decision = guard('OK — done.');
  assert.equal(decision.decision, 'block');
  assert.ok(decision.reason.includes(receipt));
  assert.match(decision.reason, /has no meta\.json/);
});

for (const ids of [{ session_id: undefined }, { session_id: '' }]) {
  test(`incomplete ids ${JSON.stringify(ids)} permit named disk checks but never folderless discovery`, async (t) => {
    const { runs, seed, guard } = await fixture(t);
    const named = await createRun(runs, 'named-run');
    await seed({ runReceipt: 'other-folder', runReceiptConflict: 'conflict-folder' });
    assert.deepEqual(guard(`RUN=${named}\nOK — done.`, ids), { systemMessage: MISSING_IDS_MESSAGE });
    const mismatch = guard(`RUN=${named}\nFAIL — invented.`, ids);
    assert.equal(mismatch.decision, 'block');
    assert.equal(mismatch.systemMessage, MISSING_IDS_MESSAGE);
    const folderless = guard('OK — done.', ids);
    assert.equal(folderless.decision, 'block');
    assert.equal(folderless.reason, noReceiptReason);
    assert.equal(folderless.systemMessage, MISSING_IDS_MESSAGE);
  });
}

for (const agentId of [undefined, '']) {
  test(`a missing agent id ${JSON.stringify(agentId)} retains the legacy try-budget fail-open`, async (t) => {
    const { runs, seed, guard } = await fixture(t);
    const named = await createRun(runs, 'named-run');
    await seed({ runReceipt: 'other-folder', runReceiptConflict: 'conflict-folder' });
    for (const reply of [`RUN=${named}\nOK — done.`, `RUN=${named}\nFAIL — invented.`, 'OK — done.']) {
      assert.deepEqual(guard(reply, { agent_id: agentId }), { systemMessage: MISSING_IDS_MESSAGE });
    }
  });
}

test('without host ids, a finished run from another order passes with a witness alarm', async (t) => {
  const { root, runs, stateDir, guard } = await fixture(t);
  const named = await createRun(runs, 'another-order', { order_id: 'another-order-id' });
  const transcript = path.join(root, 'agent.jsonl');
  await fs.writeFile(transcript, JSON.stringify({
    type: 'user', message: { content: 'order id: current-order-id' },
  }) + '\n');
  const output = guard(`RUN=${named}\nOK — done.`, {
    session_id: undefined, agent_id: undefined, agent_transcript_path: transcript,
  });
  assert.deepEqual(output, { systemMessage: MISSING_IDS_MESSAGE });
  const witness = JSON.parse(await fs.readFile(path.join(stateDir, 'handback-witness.json'), 'utf8'));
  assert.equal(witness.alarms.length, 1);
  assert.equal(witness.alarms[0].hostVersion, null);
  assert.equal(witness.alarms[0].detail, 'host omitted session_id or agent_id for codex-scout');
});

for (const receipt of ['', null, 42]) {
  test(`a non-string or empty receipt ${JSON.stringify(receipt)} is unavailable`, async (t) => {
    const { seed, guard } = await fixture(t);
    await seed({ runReceipt: receipt, runReceiptConflict: '' });
    assert.deepEqual(readReceiptEvidence({ runReceipt: receipt, runReceiptConflict: receipt }),
      { receipt: null, receiptConflict: null });
    assert.equal(guard('OK — done.').reason, noReceiptReason);
  });
}

test('an invented reply without any run folder is fail-closed', async (t) => {
  const { guard } = await fixture(t, 'codex-build', 'test-reply-guard');
  assert.deepEqual(readReceiptEvidence(undefined), { receipt: null, receiptConflict: null });
  assert.equal(decideReplyIdentity({ runDir: null, hasIds: true, receipt: null, receiptConflict: null, agentType: 'codex-build' }).block.reason, noReceiptReason);
  const decision = guard('OK — files were created.');
  assert.equal(decision.decision, 'block');
  assert.equal(decision.reason, noReceiptReason);
});

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

test('a reply naming a different folder from its receipt is blocked as external state', async (t) => {
  const { root, runs, seed, guard } = await fixture(t, 'codex-build', 'wrong-order-agent');
  const run = await createRun(runs, 'wrong-order', {
    ...ownStatus('wrong-order'),
    order_id: 'run-two-order',
  }, { status: 'OK' });
  const transcriptPath = path.join(root, 'transcript.jsonl');
  await fs.writeFile(transcriptPath, `${JSON.stringify({ message: { content: 'order id: run-three-order\ntask file: C:/task.md' } })}\n`);
  const receipt = await createRun(runs, 'receipted-run', ownStatus(), { status: 'OK' });
  await seed({ runReceipt: receipt });
  assert.deepEqual(readReceiptEvidence({ runReceipt: receipt, runReceiptConflict: run }), { receipt, receiptConflict: run });
  assert.equal(decideReplyIdentity({ runDir: run, hasIds: true, receipt, receiptConflict: null, agentType: 'codex-build' }).block.reason,
    receiptMismatchReason(run, receipt));
  const decision = guard(`RUN=${run}\nOK — run finished.`, { agent_transcript_path: transcriptPath });
  assert.equal(decision.decision, 'block');
  assert.ok(decision.reason.includes(receipt));
  assert.match(decision.reason, new RegExp(run.replaceAll('\\', '\\\\')));
  assert.match(decision.reason, /Run the canonical codex-bridge run command/);
  assert.match(decision.reason, /return that run's stdout verbatim/);
});

test('a reply naming its receipted run passes regardless of transcript order id', async (t) => {
  const { root, runs, seed, guard } = await fixture(t, 'codex-build', 'matching-order-agent');
  const run = await createRun(runs, 'matching-order', {
    ...ownStatus('matching-order'),
    order_id: 'matching-order-id',
  }, { status: 'OK' });
  const transcriptPath = path.join(root, 'transcript.jsonl');
  await fs.writeFile(transcriptPath, `${JSON.stringify({ message: { content: 'order id: different-order-id\ntask file: C:/task.md' } })}\n`);
  await seed({ runReceipt: run });
  assert.equal(guard(`RUN=${run}\nOK — run finished.`, { agent_transcript_path: transcriptPath }), null);
});

test('without host ids, named folders keep the old disk checks even with unusable transcripts', async (t) => {
  const { root, runs, guard } = await fixture(t, 'codex-build');
  const run = await createRun(runs, 'diagnostic-only', {
    ...ownStatus('diagnostic-only'),
    order_id: 'stored-order',
  }, { status: 'OK' });
  const missingIdsMessage = 'codex-bridge: the host did not report session_id and agent_id for dispatcher codex-build — whose run this answer quotes cannot be checked; run codex-bridge doctor.';
  assert.equal(missingIdsAlarm('codex-build'), missingIdsMessage);
  assert.deepEqual(decideReplyIdentity({ runDir: run, hasIds: false, receipt: 'other', receiptConflict: 'conflict', agentType: 'codex-build' }),
    { runDir: run, discoveredRun: false, discoveredStatus: null });
  assert.equal(decideReplyIdentity({ runDir: null, hasIds: false, receipt: run, receiptConflict: null, agentType: 'codex-build' }).block.reason, noReceiptReason);
  const missing = guard(`RUN=${run}\nOK — run finished.`, {
    session_id: undefined, agent_id: 'missing-transcript', agent_transcript_path: path.join(root, 'missing.jsonl'),
  });
  assert.deepEqual(missing, { systemMessage: missingIdsMessage });

  const malformedPath = path.join(root, 'malformed.jsonl');
  await fs.writeFile(malformedPath, '{ malformed\n');
  const malformed = guard(`RUN=${run}\nOK — run finished.`, {
    session_id: undefined, agent_id: 'malformed-transcript', agent_transcript_path: malformedPath,
  });
  assert.deepEqual(malformed, { systemMessage: missingIdsMessage });
});
