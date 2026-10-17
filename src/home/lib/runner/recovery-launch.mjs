/**
 * Reserves the single automatic continuation child of a closed parent run in a fixed
 * write order (Plan_80 E15/E17, arbiters A12/A15). Worker startup belongs to the caller.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonText, readJsonFileSync } from '../json-file.mjs';
import { writeStatus } from '../meta/run-state.mjs';
import { disableFlags } from '../run-config.mjs';
import { makeRunDir, runDirPath } from './launcher.mjs';
import { unsafeForCmd } from './codex-cmd.mjs';
import { readResumeInputs } from './resume-inputs.mjs';
import { resumeWorkerFields, writeResumeArtifacts } from './resume-launch.mjs';
import { threadFreshnessGap } from './thread-freshness.mjs';
import { workerOrder, writeWorkerOrder } from './worker-order.mjs';

const refuse = (reason, details) => ({ reserved: false, reason, details });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function reserveRecoveryChild({
  parentDir, meta, readSession, platform = process.platform, now = () => new Date(),
}) {
  if (meta?.continuation_eligibility?.automatic?.allowed !== true) return refuse('not-allowed');

  let status;
  try {
    status = readJsonFileSync(path.join(parentDir, 'status.json'));
    if (!isObject(status)) return refuse('parent-status-unreadable');
  } catch {
    return refuse('parent-status-unreadable');
  }
  if (Object.hasOwn(status, 'recovery')) return refuse('already-reserved');

  let parentOrder;
  try {
    parentOrder = readJsonFileSync(path.join(parentDir, 'worker.json'));
  } catch {
    return refuse('recovery-budget-missing');
  }
  const budgetMs = parentOrder?.recovery_policy?.budget_ms;
  if (!Number.isInteger(budgetMs) || budgetMs <= 0) return refuse('recovery-budget-missing');

  const resumed = readResumeInputs(parentDir);
  if (!resumed.ok) return refuse('inputs-unusable', { reasons: resumed.reasons });
  const { inputs } = resumed;
  const gap = threadFreshnessGap({ meta, status, ...(readSession === undefined ? {} : { readSession }) });
  if (gap !== null) return refuse('thread-not-fresh', gap);

  let envBytes;
  let env;
  try {
    const file = path.join(parentDir, 'env.json');
    envBytes = fs.readFileSync(file);
    env = parseJsonText(file, envBytes.toString('utf8'));
    if (!isObject(env)) return refuse('environment-missing');
  } catch {
    return refuse('environment-missing');
  }
  const isolationFlags = disableFlags(env);
  const parent = path.basename(parentDir);
  const planned = runDirPath(path.dirname(parentDir), status.slug);
  const fieldsFor = (runDir) => resumeWorkerFields({ inputs, runDir, resumedFrom: parent, isolationFlags });
  let fields;
  try {
    fields = fieldsFor(planned);
  } catch (error) {
    return refuse('arguments-invalid', { message: error.message });
  }
  const unsafe = platform === 'win32' ? unsafeForCmd(fields.args) : undefined;
  if (unsafe !== undefined) return refuse('arguments-unsafe', { argument: unsafe });

  const childDir = makeRunDir(planned);
  if (childDir !== planned) fields = fieldsFor(childDir);
  const reservedAt = now().toISOString();
  const copied = {};
  for (const key of ['agent', 'slug', 'order_id', 'phase', 'task_hash', 'task_hash_scheme', 'repo',
    'advice', 'continues', 'continued_from', 'sandbox_probe']) {
    if (Object.hasOwn(status, key)) copied[key] = status[key];
  }
  // A12/A15: a crash must leave an admissible child before publishing its order or parent link.
  writeStatus(childDir, {
    ...copied,
    state: 'running', pid: process.pid, runner_pid: process.pid,
    process_started_at: performance.timeOrigin,
    started_at: reservedAt, resumed_from: parent,
    recovery: { automatic: true, attempt: 2, parent, reserved_at: reservedAt },
  });
  fs.writeFileSync(path.join(childDir, 'env.json'), envBytes);
  const kind = meta.situation?.kind;
  const situationKind = typeof kind === 'string' && /^[a-z][a-z-]*$/.test(kind)
    ? kind : 'evidence-unknown';
  const silence = meta.situation?.silence_ms;
  const after = Number.isFinite(silence) ? ` after ${silence} ms of session silence` : '';
  writeResumeArtifacts({ runDir: childDir, inputs, situationKind,
    note: `Automatic continuation of ${parent}${after} (Plan_80 B3).` });
  const orderFields = {
    agent: parentOrder.agent, slug: parentOrder.slug, orderId: parentOrder.order_id,
    repo: parentOrder.repo, isGitRepo: parentOrder.is_git_repo, launcherPid: process.pid,
    phase: parentOrder.phase, budgetMinutes: budgetMs / 60000,
    silencePolicy: parentOrder.silence_policy, recoveryPolicy: parentOrder.recovery_policy,
    scopeNew: parentOrder.scope_new, ...fields,
  };
  writeWorkerOrder(childDir, orderFields);
  // Last on purpose: the pointer always names a child whose status, inputs and order are on disk.
  writeStatus(parentDir, {
    recovery: { child: path.basename(childDir), reserved_at: reservedAt, automatic: true },
  });
  return { reserved: true, childDir, order: workerOrder(orderFields) };
}
