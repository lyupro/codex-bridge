/** Keeps the runner and producer hook on one definition of which task owns an order id. */
import { TASK_HASH_SCHEME } from '../meta/chain.mjs';
import { orderInputName } from '../order-schema.mjs';
import { orderRuleMessage } from '../order-rules.mjs';

const byStartThenName = (left, right) => {
  const leftAt = String(left.status.started_at || '');
  const rightAt = String(right.status.started_at || '');
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
  if (String(left.run) === String(right.run)) return 0;
  return String(left.run) < String(right.run) ? -1 : 1;
};

export function runsForOrder(runs, orderId) {
  const wantedOrderId = String(orderId ?? '');
  if (!wantedOrderId) return [];
  return runs
    .filter(({ status }) => String(status?.order_id ?? '') === wantedOrderId)
    .sort(byStartThenName);
}

/**
 * On 2026-08-15 plan42-run3 reused plan42-run2's order id and received run2's verdict.
 * Compare only known fingerprints so runs predating task_hash remain fail-open.
 */
export function conflictingOrderOwner(runs, orderId, taskHash) {
  const owner = runsForOrder(runs, orderId).at(-1);
  const ownerHash = String(owner?.status.task_hash ?? '').trim().toLowerCase();
  const incomingHash = String(taskHash ?? '').trim().toLowerCase();
  return ownerHash && incomingHash && ownerHash !== incomingHash ? owner : null;
}

export function ownerPredatesHashScheme(owner) {
  return owner.status.task_hash_scheme !== TASK_HASH_SCHEME;
}

export function orderOwnerConflictText(owner, ownerDir, orderId) {
  // Plan_75 D5, 2026-10-03: an old hash cannot prove that a repeated order is a different task.
  if (ownerPredatesHashScheme(owner)) {
    return orderRuleMessage('order-id-owner', {
      violation: 'predates-hash-scheme', orderId, ownerDir,
      slug: owner.status.slug, startedAt: owner.status.started_at, hashScheme: TASK_HASH_SCHEME,
    });
  }
  return orderRuleMessage('order-id-owner', {
    violation: 'different-task', orderId, ownerDir,
    slug: owner.status.slug, startedAt: owner.status.started_at, labelName: orderInputName('order id'),
  });
}
