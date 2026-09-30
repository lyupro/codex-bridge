/**
 * Applies other owners' host updates under the initiator's lifecycle lock (Plan_65 D7, advice A6).
 * Replacing the shared image must bring eligible owners' files and hooks along, without extending
 * the initiator's force to their edits, permissions, seeds, or Codex rules registry. An owner row
 * advances only after its whole host update verifies; failures must not stop the remaining owners.
 * In-sync rows are stamped with the image fingerprint too (D11): clones of one version ship different
 * images (A6), so only the stamp tells doctor which image a host was last verified against.
 */
import fs from 'node:fs/promises';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import { buildInstallPlan, packageInfo, rulesPlan } from './manifest.mjs';
import { copyPlannedFile, planHomeWriter } from './copy.mjs';
import { readInstallRecordFile, writeInstallRecord } from './install-record.mjs';
import { imageFingerprint, ownerView } from './install-owners.mjs';
import { ownerRecord } from './owner-record.mjs';
import { ownerHost, ownerSyncLines, planOwner, planOwnerSync } from './owner-sync.mjs';
import { mergeHook } from './settings-merge.mjs';

async function applyOwner(owner, initiator, { packageRoot, env }) {
  const host = ownerHost(owner, initiator);
  // D7: a root lost after planning must not be recreated by the copy or settings writers.
  if (!(await fs.stat(host.root)).isDirectory()) throw new Error('owner root is not a directory');
  const record = await readInstallRecordFile(host);
  const prior = ownerView(record, host);
  if (!prior) throw new Error('owner is not recorded');
  const plan = await buildInstallPlan(host, packageRoot);
  const { writer } = planHomeWriter(host.brandRoot, plan);
  let files = 0;
  for (const { item, state } of owner.files) {
    if (state !== 'replace' && state !== 'create') continue;
    await copyPlannedFile(item, host.brandRoot, { writer });
    files += 1;
  }
  const hookResults = [];
  let hooks = 0;
  for (const { item, state } of owner.hooks) {
    if (state === 'register') {
      hookResults.push(await mergeHook(host.settingsPath, item.spec));
      hooks += 1;
    } else {
      hookResults.push({ createdGroup: false });
    }
  }
  const verified = await planOwner(record, record.owners[normalizeRepoPath(host.root)], initiator,
    { packageRoot, env });
  // A bare status word made the operator line read "Left <root> behind: conflict", naming no cause.
  if (verified.status !== 'in-sync') throw new Error(`verification after the update found ${verified.status}`);
  // D7: resolving an explicit root must not relabel a recorded user/project owner as host.
  await writeInstallRecord({ ...host, scope: owner.scope }, await ownerRecord({
    plan,
    rule: rulesPlan(host, packageRoot),
    targets: owner.hooks.map(({ item }) => item),
    hookResults,
    prior,
    currentPackage: await packageInfo(packageRoot),
  }), {});
  return { root: owner.root, status: 'updated', files, hooks };
}

export async function applyOwnerSync(plan, initiator, { packageRoot, env } = {}) {
  const record = await readInstallRecordFile(initiator);
  const fingerprint = imageFingerprint(record.image);
  const owners = [];
  for (const owner of plan.owners) {
    if (owner.status === 'in-sync'
      // An image without fingerprints yields null; a row can then never carry a stamp to match.
      && (record.owners[normalizeRepoPath(owner.root)]?.imageFingerprint ?? null) === fingerprint) {
      owners.push({ root: owner.root, status: 'in-sync' });
    } else if (owner.status !== 'eligible' && owner.status !== 'in-sync') {
      owners.push(owner);
    } else {
      try {
        const applied = await applyOwner(owner, initiator, { packageRoot, env });
        owners.push(owner.status === 'in-sync' && applied.files === 0 && applied.hooks === 0
          ? { root: owner.root, status: 'in-sync' } : applied);
      } catch (error) {
        owners.push({ root: owner.root, status: 'failed', reason: error.message });
      }
    }
  }
  return { owners, complete: owners.every(({ status }) => status === 'in-sync' || status === 'updated') };
}

/**
 * One entrance for every command that replaced the image: install and update both call it, so neither
 * can sync the other owners differently. A dry run only plans; it never counts as incomplete.
 */
export async function syncOtherOwners(initiator, { packageRoot, env, dryRun = false } = {}) {
  const record = await readInstallRecordFile(initiator);
  if (record?.format !== 2) return { complete: true, lines: [] };
  const plan = await planOwnerSync(record, initiator, { packageRoot, env });
  if (dryRun) return { complete: true, lines: ownerSyncLines(plan) };
  // Plan_65 D7: the initiator's force never authorizes another owner's edits.
  const result = await applyOwnerSync(plan, initiator, { packageRoot, env });
  return { complete: result.complete, lines: ownerApplyLines(result) };
}

export function ownerApplyLines(result) {
  return result.owners.flatMap((owner) => {
    if (owner.status === 'updated') {
      return [`Updated ${owner.files} file(s) and ${owner.hooks} hook(s) of ${owner.root}.`];
    }
    if (owner.status === 'failed') {
      return [`Left ${owner.root} behind: ${owner.reason}; run codex-bridge update --host "${owner.root}".`];
    }
    return ownerSyncLines({ owners: [owner] });
  });
}
