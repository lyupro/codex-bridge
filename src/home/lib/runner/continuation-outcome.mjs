/**
 * Owns what the last run of a chain was and which ready grant lines repair it.
 */
import path from 'node:path';
import { readJson } from '../write-meta.mjs';
import { recoverySuccessor } from '../meta/recovery-successor.mjs';
import { orderRuleMessage } from '../order-rules.mjs';

// One comparison of run names for the grant gate and for attach, so a repeat and a grant can never
// disagree about whether two spellings name the same folder.
export const sameRun = (runsRootPath, left, right) => {
  const a = path.resolve(runsRootPath, left);
  const b = path.resolve(runsRootPath, right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

// The 2026-08-10_220535_plan25-2-install-table-two-roots incident showed that a refusal must
// carry the repair line; otherwise a typo forces an unnecessary directory listing and retry.
export function lastRunOutcome(runsRootPath, chain) {
  const run = chain[chain.length - 1];
  if (!run) return null;
  const status = readJson(path.join(runsRootPath, run, 'status.json')) || {};
  const meta = readJson(path.join(runsRootPath, run, 'meta.json')) || {};
  const outcomeStatus = String(meta.status ?? status.status ?? status.state ?? 'unknown').trim() || 'unknown';
  const outcomeReason = String(meta.reason ?? status.reason ?? 'reason not recorded').trim() || 'reason not recorded';
  return { run, status: outcomeStatus, reason: outcomeReason, verdict: meta.status, orderId: status.order_id };
}

export function readyGrantLines(runsRootPath, chain, grantReason) {
  const last = lastRunOutcome(runsRootPath, chain);
  if (!last) return orderRuleMessage('ready-grant-line', { variant: 'none' });
  const orderId = String(last.orderId ?? '').trim();
  if (last.verdict === 'CAPACITY') {
    return orderRuleMessage('ready-grant-line', {
      variant: orderId ? 'capacity' : 'none', run: last.run, orderId,
    });
  }
  const reason = String(grantReason ?? last.reason).trim() || last.reason;
  const continuation = orderRuleMessage('ready-grant-line', { variant: 'continue', run: last.run, reason });
  // Plan_75 D1: the TradeForge failed advise spent its continuation, so show the same-pass repair.
  // A run without order_id cannot be retried (retryRefusal step d), so it gets no retry line.
  if (!last.verdict || last.verdict === 'OK' || !orderId) return continuation;
  return [continuation, orderRuleMessage('ready-grant-line', {
    variant: 'retry', run: last.run, reason: last.reason, orderId,
  })].join(' ');
}

export function lastRunHints(runsRootPath, chain, grantReason) {
  const last = lastRunOutcome(runsRootPath, chain);
  if (!last) {
    return [orderRuleMessage('grant-last-run-hint', { variant: 'none' }),
      orderRuleMessage('ready-grant-line', { variant: 'none' })].join(' ');
  }
  return [orderRuleMessage('grant-last-run-hint', {
    variant: 'last', run: last.run, status: last.status, reason: last.reason,
  }), readyGrantLines(runsRootPath, chain, grantReason)].join(' ');
}

// Plan_80 E18 O6c: explain only a validated automatic child that became the started chain's last run.
export function automaticSuccessorOf(runsRootPath, run, last) {
  const successor = recoverySuccessor(runsRootPath, run);
  return successor.state === 'valid' && successor.started && last &&
    sameRun(runsRootPath, successor.child, last) ? successor.child : null;
}
