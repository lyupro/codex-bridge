/** Installs codex-bridge files and its host hook with conflict-safe idempotency. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildInstallPlan,
  fileFingerprint,
  packageInfo,
  readInstallRecord,
  recordMatchesPackage,
  rulesPlan,
  writeInstallRecord,
} from './manifest.mjs';
import { copyPlannedFile, targetMatches } from './copy.mjs';
import { inspectHook, mergeHook } from './settings-merge.mjs';

async function targetExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export async function install({ host, dryRun = false, force = false, packageRoot } = {}) {
  const plan = await buildInstallPlan(host, packageRoot);
  const rule = { ...rulesPlan(host, packageRoot), processing: 'copy' };
  const currentPackage = await packageInfo(packageRoot);
  const record = await readInstallRecord(host);
  const inspectedHook = await inspectHook(
    host.settingsPath,
    path.join(host.agentsDir, 'hooks', 'reply-guard.mjs'),
  );
  const states = await Promise.all(plan.map(async (item) => ({
    item,
    exists: await targetExists(item.target),
    matches: await targetMatches(item, host.agentsDir),
    fingerprint: await fileFingerprint(item.target),
  })));
  const ruleState = {
    item: rule,
    exists: await targetExists(rule.target),
    matches: await targetMatches(rule, host.agentsDir),
    fingerprint: await fileFingerprint(rule.target),
  };
  const conflicts = [
    ...states.filter((state) => state.exists && !state.matches
      && (!record || (record.fingerprints
        && record.fingerprints[state.item.relativeToHost] !== state.fingerprint))),
    ...(ruleState.exists && !ruleState.matches
      && (!record?.rules || record.rules.fingerprint !== ruleState.fingerprint) ? [ruleState] : []),
  ];
  if (conflicts.length && !force) {
    const files = conflicts.map(({ item }) => `  ${item.relativeToHost || item.name}`).join('\n');
    return {
      exitCode: 1,
      output: `Conflicting files:\n${files}\nRun install again with --force to overwrite them.`,
    };
  }

  const changedFiles = states.filter((state) => !state.matches);
  const changedRule = !ruleState.matches;
  const sameRecord = recordMatchesPackage(record, plan, currentPackage,
    new Map(states.map((state) => [state.item.relativeToHost, state.fingerprint])),
    { path: rule.target, fingerprint: ruleState.fingerprint });
  if (!changedFiles.length && !changedRule && inspectedHook.present && sameRecord) {
    return { exitCode: 0, output: 'codex-bridge is already installed; nothing to do.' };
  }

  if (dryRun) {
    const lines = changedFiles.map(({ item, exists }) =>
      `${exists ? 'Would overwrite' : 'Would create'} ${item.relativeToHost}`);
    if (changedRule) {
      lines.push(`${ruleState.exists ? 'Would overwrite' : 'Would create'} ${rule.target}`);
    }
    lines.push(inspectedHook.present ? 'Hook is already registered.' : 'Would register SubagentStop hook.');
    lines.push('Would write installation record.');
    return { exitCode: 0, output: lines.join('\n') };
  }

  for (const { item } of changedFiles) await copyPlannedFile(item, host.agentsDir);
  if (changedRule) await copyPlannedFile(rule, host.agentsDir);
  const hookResult = await mergeHook(
    host.settingsPath,
    path.join(host.agentsDir, 'hooks', 'reply-guard.mjs'),
    inspectedHook,
  );
  const hookRelative = plan.find((item) => path.basename(item.target) === 'reply-guard.mjs')?.relativeToHost;
  if (!hookRelative) throw new Error('install plan does not contain hooks/reply-guard.mjs');
  const fingerprints = Object.fromEntries(await Promise.all(plan.map(async (item) =>
    [item.relativeToHost, await fileFingerprint(item.target)])));
  await writeInstallRecord(host, {
    ...currentPackage,
    installedAt: new Date().toISOString(),
    mode: 'copy',
    files: plan.map((item) => item.relativeToHost),
    fingerprints,
    rules: { path: rule.target, fingerprint: await fileFingerprint(rule.target) },
    hook: { event: 'SubagentStop', path: hookRelative, createdGroup: hookResult.createdGroup || record?.hook?.createdGroup || false },
  });
  return { exitCode: 0, output: `Installed ${plan.length + 1} files and registered the SubagentStop hook.` };
}
