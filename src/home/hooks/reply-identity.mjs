/** Decides which run a dispatcher reply answers for, from the gate's receipt (Plan_63 D10; 2026-09-24 stranger-run incident). */
import path from 'node:path';
import { readJsonFileSync } from '../lib/json-file.mjs';
import { normalizePath } from './live-runs.mjs';
import { MAX_STATE_BLOCKS } from './guard-tries.mjs';
import {
  noReceiptReason,
  noReceiptStop,
  receiptConflictReason,
  receiptConflictStop,
  receiptMismatchReason,
  receiptMismatchStop,
} from './reply-verdicts.mjs';

export function readReceiptEvidence(state) {
  return {
    receipt: typeof state?.runReceipt === 'string' && state.runReceipt.length > 0 ? state.runReceipt : null,
    receiptConflict: typeof state?.runReceiptConflict === 'string' && state.runReceiptConflict.length > 0
      ? state.runReceiptConflict : null,
  };
}

export function missingIdsAlarm(agentType) {
  return `codex-bridge: the host did not report session_id and agent_id for dispatcher ${agentType} — whose run this answer quotes cannot be checked; run codex-bridge doctor.`;
}

// Plan_63 D10: a recent stranger is never evidence for this reply; only the gate receipt is.
// Form checks stay in the caller before this decision, preserving their softer try budget.
export function decideReplyIdentity({ runDir, hasIds, receipt, receiptConflict, agentType }) {
  if (hasIds && receiptConflict) {
    return { block: {
      reason: receiptConflictReason(receipt, receiptConflict),
      stop: receiptConflictStop(MAX_STATE_BLOCKS, agentType, receipt, receiptConflict),
    } };
  }

  if (!runDir) {
    if (!(hasIds && receipt)) {
      return { block: { reason: noReceiptReason, stop: noReceiptStop(MAX_STATE_BLOCKS, agentType) } };
    }
    let discoveredStatus = null;
    try {
      discoveredStatus = readJsonFileSync(path.join(receipt, 'status.json'));
    } catch {
      discoveredStatus = null;
    }
    return { runDir: receipt, discoveredRun: true, discoveredStatus };
  }

  if (hasIds) {
    if (!receipt) {
      return { block: { reason: noReceiptReason, stop: noReceiptStop(MAX_STATE_BLOCKS, agentType) } };
    }
    if (normalizePath(runDir) !== normalizePath(receipt)) {
      return { block: {
        reason: receiptMismatchReason(runDir, receipt),
        stop: receiptMismatchStop(MAX_STATE_BLOCKS, agentType, runDir, receipt),
      } };
    }
  }
  // Review 2026-10-05_201513_plan63-r-review-20261005 and Plan_66 H2: missing ids alarm
  // in the caller; named folders retain disk checks because host contract loss must never block work.
  return { runDir, discoveredRun: false, discoveredStatus: null };
}
