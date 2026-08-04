/** Updates a recorded codex-bridge installation without overwriting unapproved host changes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { install } from './install.mjs';
import {
  buildInstallPlan,
  fileFingerprint,
  packageInfo,
  readInstallRecord,
  recordMatchesPackage,
  rulesPlan,
} from './manifest.mjs';
import { targetMatches } from './copy.mjs';
import { inspectHook } from './settings-merge.mjs';
import { addRulesOwner, readRulesRegistry } from './rules-owners.mjs';

async function exists(target) {
  try {
    return (await fs.stat(target)).isFile();
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
}

function classifyPlanned(state, record) {
  if (!state.recorded) return 'new';
  if (!state.exists) return 'missing';
  if (state.matchesPackage) return 'up-to-date';
  if (state.recordedFingerprint === state.fingerprint) return 'outdated';
  return 'modified';
}

function classifyOrphan(state, record) {
  if (!state.exists) return 'orphaned';
  if (record.fingerprints?.[state.relative] === state.fingerprint) return 'orphaned';
  return 'modified';
}

/**
 * What the run actually did, counted by outcome. `Updated codex-bridge.` alone told the operator
 * nothing about the files that were rewritten or removed on their behalf.
 */
function appliedOutput(states) {
  const count = (status) => states.filter((state) => state.status === status).length;
  const parts = [
    [count('outdated'), 'updated'],
    [count('new'), 'added'],
    [count('missing'), 'restored'],
    // A modified orphan is preserved rather than rewritten, so it is not counted here.
    [states.filter((state) => state.status === 'modified' && state.item).length, 'overwritten'],
    [states.filter((state) => state.status === 'orphaned' && state.exists).length, 'removed'],
  ].filter(([total]) => total > 0).map(([total, label]) => `${total} ${label}`);
  return parts.length ? `Updated codex-bridge: ${parts.join(', ')}.` : 'Updated codex-bridge.';
}

function conflictOutput(conflicts, legacy, dryRun) {
  const heading = dryRun ? 'Update would stop for these paths:' : 'Update stopped for these paths:';
  const lines = conflicts.map((state) => `  ${state.relative} (${state.status})`);
  if (legacy) lines.push('Installation record has no fingerprints; differing files are treated as modified.');
  lines.push('Run update again with --force to overwrite modified files and restore missing files.');
  return [heading, ...lines].join('\n');
}

function dryRunOutput(states, hookPresent, legacy) {
  const lines = [];
  for (const state of states) {
    if (state.status === 'outdated') lines.push(`Would update ${state.relative}.`);
    if (state.status === 'new') lines.push(`Would create ${state.relative}.`);
    if (state.status === 'modified' && state.item) lines.push(`Would overwrite ${state.relative}.`);
    if (state.status === 'missing') lines.push(`Would restore ${state.relative}.`);
    if (state.status === 'orphaned' && state.exists) lines.push(`Would remove ${state.relative}.`);
    if (state.status === 'modified' && !state.item) lines.push(`Would preserve modified orphan ${state.relative}.`);
  }
  if (!hookPresent) lines.push('Would register SubagentStop hook.');
  lines.push('Would write installation record with new fingerprints.');
  if (legacy && states.some((state) => state.status === 'modified')) {
    lines.push('Installation record has no fingerprints; differing files are treated as modified.');
  }
  return lines.join('\n');
}

export async function update({ host, dryRun = false, force = false, packageRoot } = {}) {
  await readRulesRegistry(host);
  const record = await readInstallRecord(host);
  if (!record) {
    return { exitCode: 1, output: 'codex-bridge is not installed. Run codex-bridge install first.' };
  }

  const plan = await buildInstallPlan(host, packageRoot);
  const rule = { ...rulesPlan(host, packageRoot), processing: 'copy' };
  const planned = new Map(plan.map((item) => [item.relativeToHost, item]));
  const plannedStates = await Promise.all(plan.map(async (item) => {
    const relative = item.relativeToHost;
    const targetExists = await exists(item.target);
    const state = {
      relative,
      item,
      recorded: record.files.includes(relative),
      recordedFingerprint: record.fingerprints?.[relative],
      exists: targetExists,
      matchesPackage: targetExists && await targetMatches(item, host.agentsDir),
      fingerprint: targetExists ? await fileFingerprint(item.target) : null,
    };
    return { ...state, status: classifyPlanned(state, record) };
  }));
  const ruleExists = await exists(rule.target);
  const ruleState = {
    relative: rule.target,
    item: rule,
    recorded: Boolean(record.rules),
    recordedFingerprint: record.rules?.fingerprint,
    exists: ruleExists,
    matchesPackage: ruleExists && await targetMatches(rule, host.agentsDir),
    fingerprint: ruleExists ? await fileFingerprint(rule.target) : null,
  };
  ruleState.status = classifyPlanned(ruleState, record);
  const orphanStates = await Promise.all(record.files
    .filter((relative) => !planned.has(relative))
    .map(async (relative) => {
      const target = path.join(host.root, relative);
      const targetExists = await exists(target);
      const state = {
        relative,
        item: null,
        exists: targetExists,
        fingerprint: targetExists ? await fileFingerprint(target) : null,
      };
      return { ...state, status: classifyOrphan(state, record) };
    }));
  const states = [...plannedStates, ruleState, ...orphanStates];
  const conflicts = states.filter((state) => state.status === 'modified' || state.status === 'missing');
  const legacy = !record.fingerprints;
  if (conflicts.length && !force) {
    return { exitCode: 1, output: conflictOutput(conflicts, legacy, dryRun) };
  }

  const guardPath = path.join(host.agentsDir, 'hooks', 'reply-guard.mjs');
  const inspectedHook = await inspectHook(host.settingsPath, guardPath);
  const currentPackage = await packageInfo(packageRoot);
  const recordCurrent = recordMatchesPackage(record, plan, currentPackage,
    new Map(plannedStates.map((state) => [state.relative, state.fingerprint])),
    { path: rule.target, fingerprint: ruleState.fingerprint });
  const changed = states.some((state) => state.status !== 'up-to-date');
  if (!changed && inspectedHook.present && recordCurrent) {
    if (!dryRun) await addRulesOwner(host);
    return { exitCode: 0, output: 'codex-bridge is up to date' };
  }
  if (dryRun) {
    return { exitCode: 0, output: dryRunOutput(states, inspectedHook.present, legacy) };
  }

  for (const state of orphanStates) {
    if (state.status === 'orphaned' && state.exists) await fs.rm(path.join(host.root, state.relative));
  }
  const installed = await install({ host, force: true, packageRoot });
  if (installed.exitCode !== 0) return installed;
  return { exitCode: 0, output: appliedOutput(states) };
}
