/** Keeps the runner and producer hook on one definition of which task owns an order id. */

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
