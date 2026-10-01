/**
 * Holds purge's one set of refusal checks: under a live ticket it asks both consents and mints
 * the executor's authorization; for a dry run it only reports.
 *
 * Plan_65 D12 items 5-6 and D14 require one ordered check inside the lifecycle transaction:
 * live runs, installation inventory, inventory consent, then separate data consent. The executor
 * consumes its result instead of checking again, so permission cannot outlive or change its plan.
 */
import path from 'node:path';
import { assertLiveTicket } from './lifecycle-transaction.mjs';
import { askPurgeConsent } from './inventory-removal.mjs';
import { inspectLiveRuns, liveRunLines } from './purge-live-runs.mjs';
import { buildHomeRemovalPlan } from './home-removal-plan.mjs';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';

const authorizations = new WeakMap();

// D14 item 2: this is THE live-run step, reached only as the default liveRunCheck of
// runPurgePreflight and diagnosePurge. Plan_74 replaces it alone with the admission gate.
export function checkLiveRuns() {
  return inspectLiveRuns();
}

function freezePlan(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezePlan(child);
    Object.freeze(value);
  }
  return value;
}

const refused = (line) => ({ verdict: 'refused', lines: [line] });

export function planRefusals(plan, host) {
  if (plan.homeRoot === 'error') {
    return [`Could not read ${host.brandRoot}: purge cannot inventory the home.`];
  }
  if (plan.recordState === 'corrupt') {
    return [`The installation record of ${host.brandRoot} is unreadable: purge cannot tell who uses this home.`];
  }

  const ownerKey = normalizeRepoPath(host.root);
  const otherOwners = plan.recordState === 'valid'
    ? Object.keys(plan.format2.owners).filter((root) => root !== ownerKey)
    : [];
  return otherOwners.map((root) => `${root} is recorded as using ${host.brandRoot}; uninstall it first.`);
}

export function purgeDataFiles(plan) {
  return plan.rows.filter((row) => row.removal === 'purge-only' && row.action === 'remove')
    .map((row) => row.relative).sort();
}

export async function diagnosePurge({ host, packageRoot, liveRunCheck = checkLiveRuns }) {
  const liveRuns = await liveRunCheck();
  const plan = await buildHomeRemovalPlan({
    command: 'purge', host, packageRoot, imagePolicy: { remove: true, reason: 'purge' },
  });
  return {
    refusals: [...liveRunLines(liveRuns), ...planRefusals(plan, host)], plan, dataFiles: purgeDataFiles(plan),
  };
}

export async function runPurgePreflight({ host, ticket, packageRoot, options = {}, liveRunCheck = checkLiveRuns }) {
  assertLiveTicket(ticket, host);
  const liveRuns = await liveRunCheck();
  if (liveRuns.verdict !== 'clear') return { verdict: 'refused', lines: liveRunLines(liveRuns) };

  const plan = await buildHomeRemovalPlan({
    command: 'purge', host, packageRoot, imagePolicy: { remove: true, reason: 'purge' },
  });
  const lines = planRefusals(plan, host);
  if (lines.length) return { verdict: 'refused', lines };

  const ownerKey = normalizeRepoPath(host.root);
  const inventoryConsent = await askPurgeConsent(host, 'inventory', options);
  if (inventoryConsent === 'cancel') return { verdict: 'cancelled' };
  if (inventoryConsent === 'no') {
    return refused(`Purge needs your confirmation that no other host uses ${host.brandRoot}.`);
  }

  const dataFiles = purgeDataFiles(plan);
  const dataConsent = await askPurgeConsent(host, 'data', options, dataFiles);
  if (dataConsent === 'cancel') return { verdict: 'cancelled' };
  if (dataConsent === 'no') {
    return refused(`Purge needs your consent to delete your data in ${host.brandRoot}.`);
  }

  freezePlan(plan);
  const authorization = Object.freeze({});
  authorizations.set(authorization, { home: path.resolve(host.brandRoot), ownerKey, ticket, plan });
  return { verdict: 'authorized', plan, authorization };
}

export function consumePurgeAuthorization(authorization, host, plan) {
  const entry = authorizations.get(authorization);
  if (!entry) throw new Error('purge requires its preflight authorization (Plan_65 D12 item 6)');
  // D14: every attempt consumes the capability, including a stale ticket or wrong plan/home.
  authorizations.delete(authorization);
  assertLiveTicket(entry.ticket, host);
  if (path.resolve(host.brandRoot) !== entry.home) throw new Error('purge authorization belongs to a different home');
  if (entry.plan !== plan) throw new Error('purge authorization was granted for a different plan');
}
