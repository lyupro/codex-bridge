/**
 * Plans other owners' host updates without writes or locks (Plan_65 D7, advice A6).
 * Replacing the shared image leaves their agents, commands, and guards behind. Only an owner's
 * recorded, unedited files may catch up; the initiator's force never authorizes another owner's
 * conflicts, permissions, seeds, or unrelated settings. B13e2 applies and verifies this plan.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import { resolveHost } from './hosts.mjs';
import { buildInstallPlan, fileFingerprint } from './manifest.mjs';
import { targetMatches } from './copy.mjs';
import { fingerprintFor, recordFileKey } from './install-record.mjs';
import { ownerView, validateFormat2 } from './install-owners.mjs';
import { hookTargets } from './hook-targets.mjs';
import { inspectHook } from './settings-merge.mjs';

async function fileState(item, host, view) {
  let target;
  try {
    target = await fs.lstat(item.target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // D7: lstat must precede content reads, including for dangling links and Windows junctions.
  if (target?.isSymbolicLink()) return { item, state: 'conflict', reason: 'link' };
  if (!target) {
    const recorded = view.files.some((file) => recordFileKey(file) === recordFileKey(item));
    return recorded
      ? { item, state: 'conflict', reason: 'missing' }
      : { item, state: 'create' };
  }
  if (target.isFile()) {
    if (await targetMatches(item, host.brandRoot)) return { item, state: 'current' };
    const recorded = fingerprintFor(view, item);
    if (recorded !== undefined && await fileFingerprint(item.target) === recorded) {
      return { item, state: 'replace' };
    }
  }
  return { item, state: 'conflict', reason: 'changed' };
}

async function planOwner(record2, owner, initiator, { packageRoot, env }) {
  const entry = { root: owner.root, scope: owner.scope, version: owner.version, files: [], hooks: [] };
  const host = resolveHost({
    host: owner.root,
    scope: owner.scope,
    brandRoot: initiator.brandRoot,
    // A resolved host has no codexHome field; it keeps the Codex home only as `<home>/rules`.
    codexHome: path.dirname(initiator.codexRulesDir),
  });
  try {
    if (!(await fs.stat(host.root)).isDirectory()) {
      return { ...entry, status: 'unreachable', reason: 'ENOTDIR' };
    }
    await fs.readdir(host.root);
  } catch (error) {
    return { ...entry, status: 'unreachable', reason: error.code === 'ENOENT' ? 'absent' : error.code };
  }

  const view = ownerView(record2, host);
  const items = (await buildInstallPlan(host, packageRoot)).filter((item) => item.root === 'claude');
  try {
    for (const item of items) entry.files.push(await fileState(item, host, view));
  } catch (error) {
    return { ...entry, status: 'unreachable', reason: error.code ?? error.message };
  }
  const targets = hookTargets(host, env);
  try {
    for (const item of targets) {
      const inspected = await inspectHook(host.settingsPath, item.spec);
      entry.hooks.push({ item, state: inspected.current ? 'current' : 'register' });
    }
  } catch (error) {
    return { ...entry, status: 'unreachable', reason: `settings unreadable: ${error.message}` };
  }
  const conflict = entry.files.some(({ state }) => state === 'conflict');
  const pending = entry.files.some(({ state }) => state === 'replace' || state === 'create')
    || entry.hooks.some(({ state }) => state === 'register');
  return { ...entry, status: conflict ? 'conflict' : pending ? 'eligible' : 'in-sync' };
}

export async function planOwnerSync(record2, initiator, { packageRoot, env } = {}) {
  validateFormat2(record2);
  const key = normalizeRepoPath(initiator.root);
  const others = Object.values(record2.owners)
    .filter((owner) => normalizeRepoPath(owner.root) !== key)
    .sort((a, b) => a.root.localeCompare(b.root));
  const owners = [];
  for (const owner of others) owners.push(await planOwner(record2, owner, initiator, { packageRoot, env }));
  return { owners };
}

export function ownerSyncLines(plan) {
  const lines = [];
  for (const owner of plan.owners) {
    if (owner.status === 'eligible') {
      const files = owner.files.filter(({ state }) => state === 'replace' || state === 'create').length;
      const hooks = owner.hooks.filter(({ state }) => state === 'register').length;
      lines.push(`Would update ${files} file(s) and ${hooks} hook(s) of ${owner.root}.`);
    } else if (owner.status === 'conflict') {
      const conflicts = owner.files.filter(({ state }) => state === 'conflict')
        .map(({ item, reason }) => `${item.relativeToRoot} (${reason})`).join(', ');
      lines.push(`Left ${owner.root} behind: ${conflicts}; run codex-bridge update --host "${owner.root}" after resolving it.`);
    } else if (owner.status === 'unreachable') {
      lines.push(`Left ${owner.root} behind: ${owner.reason}; run codex-bridge update --host "${owner.root}" when it is available.`);
    }
  }
  return lines;
}
