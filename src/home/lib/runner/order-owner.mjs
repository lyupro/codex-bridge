/** Keeps the runner and producer hook on one definition of which task owns an order id. */
import { TASK_HASH_SCHEME } from '../meta/chain.mjs';
import { orderInputName } from '../order-schema.mjs';

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
  const identity = `Order id collision: ${JSON.stringify(String(orderId ?? ''))} already belongs to run folder ${ownerDir} ` +
    `(slug ${owner.status.slug}, started_at ${owner.status.started_at})`;
  // Plan_75 D5, 2026-10-03: an old hash cannot prove that a repeated order is a different task.
  if (ownerPredatesHashScheme(owner)) {
    return `${identity}, recorded before the task header (hash scheme ${TASK_HASH_SCHEME}), so its task cannot be compared. ` +
      `Its answer is already on disk in that folder (codex-bridge read "${ownerDir}"). ` +
      'Another pass of that order needs a continue:/retry: header line; a new task needs a new order id.';
  }
  return `${identity} with a different task. Use a new order id (${orderInputName('order id')}), or a continue:/retry: header line ` +
    'if this is another pass of that order.';
}
