/**
 * Holds one kernel claim per project run store and exact order id during preparation.
 * Plan_60 D4/D4c: on 2026-09-24 two launchers started 2.8 seconds apart with one order id
 * and both ran and billed; a kernel-held claim queues preparation and dies with its holder.
 */
import { randomUUID } from 'node:crypto';
import {
  acquireKernelLock, directoryDigest, kernelLockAddress, kernelLockStrategy,
} from '../kernel-lock.mjs';
import { parseJsonText } from '../json-file.mjs';

// Plan_60 D4/D4c: preparation takes seconds; expiry must refuse rather than permit double billing.
export const ORDER_CLAIM_TIMING = Object.freeze({ waitMs: 60_000, retryMs: 100, answerTimeoutMs: 1_000 });

export function orderClaimAddress(projectRunsRoot, orderId, platform = process.platform) {
  if (typeof orderId !== 'string' || orderId.length === 0) {
    throw new TypeError('orderId must be a non-empty string');
  }
  // Plan_60 A4 r5: owner matching is case-sensitive; retries must retain the exact order id.
  const digest = directoryDigest(projectRunsRoot, { suffix: orderId });
  if (digest === null) throw new Error(`project runs folder does not exist: ${projectRunsRoot}`);
  if (kernelLockStrategy(platform) === null) return null;
  return kernelLockAddress('order', digest, platform);
}

export async function acquireOrderClaim({
  projectRunsRoot, orderId, role, platform = process.platform,
  timing = ORDER_CLAIM_TIMING, createServer,
}) {
  if (role !== 'launcher' && role !== 'worker') {
    throw new TypeError('role must be launcher or worker');
  }
  const address = orderClaimAddress(projectRunsRoot, orderId, platform);
  if (address === null) return { claimed: false, unsupported: true, release: async () => {} };
  const holder = { pid: process.pid, role, orderId, token: randomUUID() };
  const result = await acquireKernelLock({
    address, holder, ...timing, parseAnswer: parseClaimHolder, label: 'order claim', createServer,
  });
  if (result.held) return { claimed: true, release: result.release };
  return { claimed: false, busy: true, holder: result.holder };
}

export function parseClaimHolder(line) {
  try {
    const holder = parseJsonText('<order claim holder>', line);
    if (holder === null || typeof holder !== 'object') return null;
    if (!Number.isInteger(holder.pid) || holder.pid <= 0) return null;
    if (holder.role !== 'launcher' && holder.role !== 'worker') return null;
    for (const key of ['orderId', 'token', 'acquiredAt']) {
      if (typeof holder[key] !== 'string' || holder[key].length === 0) return null;
    }
    return holder;
  } catch {
    return null;
  }
}

export function orderClaimBusyText(orderId, holder) {
  // Plan_60 D4/D4c: a holder answer diagnoses contention but cannot authorize another launch.
  const owner = holder === null
    ? 'a process that did not answer (unverified)'
    : `${holder.role} pid ${holder.pid} since ${holder.acquiredAt}`;
  return `order id "${orderId}" is being launched by ${owner}; repeat the same command later — `
    + 'it attaches to that run instead of starting another. The run folder was not created; quota was not spent.';
}
