/**
 * The half that outlives the caller: Codex itself, the "after" snapshots, the verdict.
 *
 * It takes its whole order from worker.json, written by launcher.mjs into the run folder —
 * after the split that file is the only connection between the two halves. Read here:
 * `repo`, `agent`, `args`, `is_git_repo`, `budget_minutes`, `order_id`, `silence_policy`,
 * `recovery_policy`. Written there: those fields plus
 * `phase`, `slug`, `launcher_pid` and `scope_new`, which nothing here needs but a run folder read back
 * months later does. The launcher must write the selected phase's budget into worker.json before
 * spawning this half, so the worker never re-reads config.json and one run cannot acquire two
 * configurations.
 * Neither side may change the shape alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFileSync } from '../json-file.mjs';
import { collect, renderReply, exitCodeFor, AGENTS, writeFailure } from '../write-meta.mjs';
import { writeStatus } from '../meta/run-state.mjs';
import { setRun, adoptRun, emitReply } from './run-context.mjs';
import { writeBuildAfter } from './build-evidence.mjs';
import { runCodex } from './codex-cmd.mjs';
import { createSilenceWatchdog } from './silence-watchdog.mjs';
import { buildStopRecord } from './stop-record.mjs';
import { admitWorker } from './worker-admission.mjs';
import { orderClaimHolderText } from './order-claim.mjs';
import { EXIT } from './exit-codes.mjs';
import { commitRunRecord } from './run-autocommit.mjs';
import { reserveRecoveryChild } from './recovery-launch.mjs';

// Plan_80 E17/O5e: these seams make two attempts testable without a real Codex.
const WORKER_DEPS = Object.freeze({
  admitWorker, runCodex, collect, reserveRecoveryChild, commitRunRecord,
  exit: (code) => process.exit(code),
});

/**
 * Runs the order in runDir and answers into reply.txt, never to a console — nothing here
 * may depend on anyone still being on the other end of a pipe.
 * Dependency seams allow the two-attempt sequence to be tested without a real Codex.
 */
export async function worker(runDir, deps = WORKER_DEPS) {
  const cfg = readJsonFileSync(path.join(runDir, 'worker.json'));
  setRun(runDir, cfg.agent);
  const admission = await deps.admitWorker({ runDir, orderId: cfg.order_id });
  if (!admission.admitted) {
    // Plan_60 A4 r4: a replacement launcher may have closed this run while the worker was starting.
    if (admission.reason === 'claim-timeout') {
      const { reply } = writeFailure(
        runDir, cfg.agent, 'run worker was not admitted: the order claim stayed busy',
        [`Claim held by ${orderClaimHolderText(admission.holder)}`, 'Codex was not started; quota was not spent'],
      );
      emitReply(reply);
      // Plan_77 B6: publish the verdict before Git can wait on a lock or repository hook.
      deps.commitRunRecord({ runDir });
    }
    deps.exit(EXIT.FAIL);
    return;
  }

  const { meta, reply } = await runPass(runDir, cfg, deps);
  if (meta.continuation_eligibility?.automatic?.allowed === true) {
    const reservation = deps.reserveRecoveryChild({ parentDir: runDir, meta });
    if (reservation.reserved) {
      // A12/A15: reservation publishes the parent's pointer before its reply can be seen.
      emitReply(renderReply(runDir, cfg.agent, meta));
      deps.commitRunRecord({ runDir });
      const { childDir, order } = reservation;
      adoptRun(childDir, cfg.agent);
      const childAdmission = await deps.admitWorker({ runDir: childDir, orderId: order.order_id });
      if (!childAdmission.admitted) {
        const { reply: childReply } = writeFailure(
          childDir, cfg.agent, `automatic continuation was not admitted: ${childAdmission.reason}`,
          ['Codex was not started; quota was not spent'], true,
        );
        emitReply(childReply);
        deps.commitRunRecord({ runDir: childDir });
        deps.exit(EXIT.FAIL);
        return;
      }
      // E17/O5e: the child spends the recovery attempt; there is deliberately no loop.
      const { meta: childMeta, reply: childReply } = await runPass(childDir, order, deps);
      emitReply(childReply);
      deps.commitRunRecord({ runDir: childDir });
      deps.exit(exitCodeFor(childMeta.status));
      return;
    }
    writeStatus(runDir, {
      recovery_refused: { reason: reservation.reason, at: new Date().toISOString() },
    });
  }
  emitReply(reply);
  // Plan_77 B6: the launcher must receive its reply before any autocommit delay.
  deps.commitRunRecord({ runDir });
  deps.exit(exitCodeFor(meta.status));
}

async function runPass(runDir, cfg, deps) {
  const repoRoot = cfg.repo;
  const watchdog = createSilenceWatchdog({
    runDir,
    arming: cfg.recovery_policy?.watchdog?.arming ?? 'off',
    thresholdMs: cfg.silence_policy?.threshold_ms ?? null,
  });
  const run = await deps.runCodex(
    cfg.args,
    fs.readFileSync(path.join(runDir, 'task.md'), 'utf8'),
    path.join(runDir, 'events.jsonl'),
    cfg.budget_minutes,
    { cwd: cfg.repo, watchdog },
  );
  // This runner-owned fact cannot be forged through events.jsonl, which Codex can write.
  // Written even when no deadline fired: `false` is the marker that a runner was watching,
  // and an archived run with no field at all must stay distinguishable from a run that lived.
  // `stdio_drained: false` separately records an exit that needed the grace fallback because
  // a grandchild kept a pipe open, the distinction the 2026-08-06 incident made necessary.
  writeStatus(runDir, {
    stopped_on_deadline: run.stoppedOnDeadline,
    stopped_by_silence: run.stoppedBySilence,
    elapsed_ms: run.elapsedMs,
    stdio_drained: run.stdioDrained,
    stop: buildStopRecord(run, runDir, cfg.agent),
  });

  if (cfg.agent === 'codex-build') writeBuildAfter({ runDir, repoRoot, isGitRepo: cfg.is_git_repo });

  // Human-readable report is carried inside the schema: a read-only scout cannot write
  // files itself, so the runner unpacks it.
  const resultPath = path.join(runDir, AGENTS[cfg.agent].result);
  if (cfg.agent !== 'codex-review') {
    try {
      const result = readJsonFileSync(resultPath);
      if (result.report_markdown) fs.writeFileSync(path.join(runDir, 'report.md'), `${result.report_markdown}\n`);
    } catch {
      // No parseable result — write-meta.mjs turns that into FAIL with the log reason.
    }
  }

  // collect() writes meta.json and closes status.json; reply.txt comes last, so the launcher
  // seeing a reply is proof the verdict behind it is already on disk.
  return deps.collect(runDir, cfg.agent, run.exit);
}
