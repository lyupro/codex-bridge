/** Plan_80 E17/O5e: two worker attempts without starting Codex or spending quota. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { worker } from '../../src/home/lib/runner/worker.mjs';
import { setWorkerDir, getRun } from '../../src/home/lib/runner/run-context.mjs';
import { AGENTS, exitCodeFor, renderReply } from '../../src/home/lib/write-meta.mjs';
import { writeStatus } from '../../src/home/lib/meta/run-state.mjs';
import { abortedPreStart } from '../../src/home/lib/meta/pre-start.mjs';
import { stop } from '../../cli/stop.mjs';

const read = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');
const json = (dir, name) => JSON.parse(read(dir, name));
const writeJson = (dir, name, value) =>
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);

function fixture({ allowed = false, parentStatus = 'LIMIT', childStatus = 'OK',
  refusal = null, childRefusal = null, beforeChildAdmission = () => {} } = {}) {
  const root = makeTempTree('worker-continuation-');
  const parentDir = path.join(root, 'parent');
  const childDir = path.join(root, 'child');
  const cfg = {
    agent: 'codex-scout', repo: path.join(root, 'parent-repo'), args: ['exec', '--parent'],
    budget_minutes: 3, order_id: 'parent-order', is_git_repo: false,
    silence_policy: { threshold_ms: null }, recovery_policy: { watchdog: { arming: 'off' } },
  };
  const order = { ...cfg, args: ['exec', 'resume', 'fixture-thread'],
    repo: path.join(root, 'child-repo'), budget_minutes: 2, order_id: 'child-order' };
  fs.mkdirSync(parentDir);
  writeJson(parentDir, 'worker.json', cfg);
  writeStatus(parentDir, { state: 'running', agent: cfg.agent, repo: cfg.repo });
  fs.writeFileSync(path.join(parentDir, 'task.md'), 'parent frozen task\n');
  writeJson(parentDir, AGENTS[cfg.agent].result, { report_markdown: 'parent report' });
  const calls = [];
  const runs = [];
  const exits = [];
  const records = [];
  const metas = new Map();
  const metaBytes = new Map();
  const sentinel = new Error('worker exit');
  const deps = {
    async admitWorker({ runDir, orderId }) {
      calls.push(`admit:${path.basename(runDir)}`);
      assert.equal(orderId, runDir === parentDir ? cfg.order_id : order.order_id);
      assert.deepEqual(getRun(), { dir: runDir, agent: cfg.agent });
      if (runDir === childDir) {
        // A12/A15 pre-mortem: the parent's pointer and reply must precede child admission.
        assert.equal(json(parentDir, 'status.json').recovery.child, 'child');
        assert.equal(read(parentDir, 'reply.txt'), `${renderReply(parentDir, cfg.agent, metas.get(parentDir))}\n`);
        assert.deepEqual(records, [parentDir]);
        assert.equal(fs.existsSync(path.join(childDir, 'reply.txt')), false);
        calls.push('parent-reply-visible');
        await beforeChildAdmission({ parentDir, childDir });
        if (childRefusal) return { admitted: false, reason: childRefusal };
      }
      return { admitted: true };
    },
    async runCodex(args, task, eventsPath, budget, options) {
      const runDir = path.dirname(eventsPath);
      calls.push(`run:${path.basename(runDir)}`);
      runs.push({ args, task, eventsPath, budget, options });
      assert.equal(fs.existsSync(path.join(runDir, 'meta.json')), false);
      return { exit: 1, stoppedOnDeadline: false,
        elapsedMs: 17, stdioDrained: true };
    },
    collect(runDir, agent, exit) {
      calls.push(`collect:${path.basename(runDir)}`);
      assert.equal(agent, cfg.agent);
      assert.equal(exit, 1);
      const status = json(runDir, 'status.json');
      assert.equal(status.stopped_on_deadline, false);
      assert.equal(Object.hasOwn(status, 'stopped_by_silence'), false);
      assert.equal(status.elapsed_ms, 17);
      assert.equal(status.stdio_drained, true);
      const child = runDir === childDir;
      const meta = {
        agent, status: child ? childStatus : parentStatus, reason: 'fixture verdict',
        finished_at: '2026-10-17T00:00:00.000Z', result_ok: false,
        resumed_from: child ? 'parent' : null, tokens: null, tokens_reported: false,
        continuation_eligibility: { automatic: { allowed: child ? false : allowed,
          reasons: child ? ['recovery-attempt-spent'] : [] } },
      };
      // Match collect's durable ordering: recorded verdict first, closed status second.
      writeJson(runDir, 'meta.json', meta);
      writeStatus(runDir, { state: 'finished', status: meta.status, finished_at: meta.finished_at });
      metas.set(runDir, meta);
      metaBytes.set(runDir, read(runDir, 'meta.json'));
      return { meta, reply: child ? 'child collected reply' : 'parent collected reply' };
    },
    reserveRecoveryChild({ parentDir: dir, meta }) {
      calls.push('reserve');
      assert.equal(dir, parentDir);
      assert.equal(meta, metas.get(parentDir));
      assert.equal(json(parentDir, 'status.json').state, 'finished');
      assert.equal(fs.existsSync(path.join(parentDir, 'reply.txt')), false);
      if (refusal) return { reserved: false, reason: refusal, details: {} };
      fs.mkdirSync(childDir);
      writeStatus(childDir, { state: 'running', resumed_from: 'parent',
        recovery: { automatic: true, attempt: 2, parent: 'parent' } });
      fs.writeFileSync(path.join(childDir, 'task.md'), 'child frozen task\n');
      writeJson(childDir, 'worker.json', order);
      writeJson(childDir, AGENTS[cfg.agent].result, { report_markdown: 'child report' });
      writeStatus(parentDir, { recovery: { child: 'child', automatic: true,
        reserved_at: '2026-10-17T00:00:00.000Z' } });
      return { reserved: true, childDir, order };
    },
    commitRunRecord({ runDir }) {
      calls.push(`commit:${path.basename(runDir)}`);
      assert.equal(fs.existsSync(path.join(runDir, 'reply.txt')), true);
      records.push(runDir);
    },
    exit(code) {
      calls.push('exit');
      exits.push(code);
      throw sentinel;
    },
  };
  return { parentDir, childDir, cfg, order, calls, runs, exits, records, metas, metaBytes,
    async execute() {
      setWorkerDir(parentDir);
      await assert.rejects(worker(parentDir, deps), (error) => error === sentinel);
      assert.equal(exits.length, 1);
    } };
}

for (const status of ['OK', 'FAIL', 'LIMIT', 'UNAVAILABLE']) {
  test(`automatic recovery not allowed: one pass and the ${status} exit`, async () => {
    const f = fixture({ parentStatus: status });
    await f.execute();
    assert.equal(f.runs.length, 1);
    assert.equal(f.calls.includes('reserve'), false);
    assert.equal(read(f.parentDir, 'reply.txt'), 'parent collected reply\n');
    assert.deepEqual(f.exits, [exitCodeFor(status)]);
    assert.deepEqual(f.records, [f.parentDir]);
    assert.equal(read(f.parentDir, 'report.md'), 'parent report\n');
    assert.deepEqual(f.runs[0].args, f.cfg.args);
    assert.equal(f.runs[0].task, 'parent frozen task\n');
    assert.equal(f.runs[0].budget, f.cfg.budget_minutes);
    assert.equal(f.runs[0].options.cwd, f.cfg.repo);
    assert.ok(f.runs[0].options.watchdog);
  });
}

for (const allowed of [undefined, null, 'true', 1]) {
  test(`automatic eligibility must be exactly true (${String(allowed)})`, async () => {
    const f = fixture({ allowed });
    await f.execute();
    assert.equal(f.runs.length, 1);
    assert.equal(f.calls.includes('reserve'), false);
  });
}

for (const childStatus of ['OK', 'FAIL', 'LIMIT', 'UNAVAILABLE']) {
  test(`reserved child runs once and determines the ${childStatus} exit`, async () => {
    const f = fixture({ allowed: true, childStatus });
    await f.execute();
    assert.equal(f.runs.length, 2);
    assert.deepEqual(f.calls, ['admit:parent', 'run:parent', 'collect:parent', 'reserve',
      'commit:parent', 'admit:child', 'parent-reply-visible', 'run:child', 'collect:child', 'commit:child', 'exit']);
    assert.deepEqual(f.runs[1].args, f.order.args);
    assert.equal(f.runs[1].options.cwd, f.order.repo);
    assert.ok(f.runs[1].options.watchdog);
    assert.equal(f.runs[1].budget, f.order.budget_minutes);
    assert.equal(f.runs[1].task, 'child frozen task\n');
    assert.equal(f.runs[1].eventsPath, path.join(f.childDir, 'events.jsonl'));
    assert.equal(read(f.parentDir, 'reply.txt'), `${renderReply(f.parentDir, f.cfg.agent, f.metas.get(f.parentDir))}\n`);
    assert.equal(read(f.childDir, 'reply.txt'), 'child collected reply\n');
    assert.equal(read(f.childDir, 'report.md'), 'child report\n');
    assert.equal(read(f.parentDir, 'meta.json'), f.metaBytes.get(f.parentDir));
    assert.deepEqual(f.exits, [exitCodeFor(childStatus)]);
    assert.deepEqual(f.records, [f.parentDir, f.childDir]);
    assert.deepEqual(f.metas.get(f.childDir).continuation_eligibility.automatic,
      { allowed: false, reasons: ['recovery-attempt-spent'] });
    assert.equal(f.calls.filter((call) => call === 'reserve').length, 1);
  });
}

test('reservation refusal records housekeeping without changing the verdict bytes', async () => {
  const f = fixture({ allowed: true, refusal: 'thread-not-fresh' });
  const before = Date.now();
  await f.execute();
  assert.equal(f.runs.length, 1);
  const status = json(f.parentDir, 'status.json');
  assert.equal(status.recovery_refused.reason, 'thread-not-fresh');
  const at = Date.parse(status.recovery_refused.at);
  assert.ok(at >= before && at <= Date.now());
  assert.equal(new Date(at).toISOString(), status.recovery_refused.at);
  assert.equal(status.state, 'finished');
  assert.equal(Object.hasOwn(status, 'recovery'), false);
  assert.equal(read(f.parentDir, 'meta.json'), f.metaBytes.get(f.parentDir));
  assert.equal(read(f.parentDir, 'reply.txt'), 'parent collected reply\n');
  assert.deepEqual(f.exits, [exitCodeFor('LIMIT')]);
  assert.deepEqual(f.records, [f.parentDir]);
});

for (const reason of ['claim-timeout', 'run-closed']) {
  test(`child admission ${reason} stays aborted before start (A15 pre-mortem 3)`, async () => {
    const f = fixture({ allowed: true, childRefusal: reason });
    await f.execute();
    assert.equal(f.runs.length, 1);
    assert.equal(json(f.childDir, 'status.json').state, 'aborted_pre_start');
    assert.equal(abortedPreStart(f.childDir), true);
    assert.equal(json(f.childDir, 'meta.json').reason, `automatic continuation was not admitted: ${reason}`);
    assert.match(read(f.childDir, 'reply.txt'), /Codex was not started; quota was not spent/);
    assert.equal(read(f.parentDir, 'meta.json'), f.metaBytes.get(f.parentDir));
    assert.equal(read(f.parentDir, 'reply.txt'), `${renderReply(f.parentDir, f.cfg.agent, f.metas.get(f.parentDir))}\n`);
    assert.deepEqual(f.exits, [exitCodeFor('FAIL')]);
    assert.deepEqual(f.records, [f.parentDir, f.childDir]);
    assert.equal(f.calls.filter((call) => call === 'reserve').length, 1);
  });
}

test('stop after the parent reply keeps its recorded verdict and all files (pre-mortem 4)', async () => {
  let checked = false;
  const f = fixture({ allowed: true, async beforeChildAdmission({ parentDir }) {
    const snapshot = () => Object.fromEntries(fs.readdirSync(parentDir).map((name) =>
      [name, read(parentDir, name)]));
    const before = snapshot();
    const result = await stop({ run: parentDir });
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /already has a verdict \(LIMIT\); no changes made/);
    assert.deepEqual(snapshot(), before);
    checked = true;
  } });
  await f.execute();
  assert.equal(checked, true);
  assert.equal(f.runs.length, 2);
  assert.equal(f.calls.filter((call) => call === 'reserve').length, 1);
});
