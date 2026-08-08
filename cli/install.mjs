/** Installs codex-bridge files and its host hook with conflict-safe idempotency. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildInstallPlan,
  fileFingerprint,
  HOOK_DEFINITIONS,
  installedHookPath,
  packageInfo,
  readInstallRecord,
  recordMatchesPackage,
  rulesPlan,
  seedPlan,
  writeInstallRecord,
} from './manifest.mjs';
import { copyPlannedFile, targetMatches } from './copy.mjs';
import { commandFor, inspectHook, mergeHook, withSettingsRun } from './settings-merge.mjs';
import { addRulesOwner, readRulesRegistry } from './rules-owners.mjs';
import { readRunConfig, retentionNotice } from '../src/run-config.mjs';

const WARNING = '\u001b[33m';
const RESET = '\u001b[0m';

async function targetExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function hookTargets(host) {
  return HOOK_DEFINITIONS.map((definition) => {
    const target = installedHookPath(host, definition);
    return {
      definition,
      target,
      relative: path.relative(host.root, target).split(path.sep).join('/'),
      spec: { event: definition.event, matcher: definition.matcher, command: commandFor(target) },
    };
  });
}

function recordHasHooks(record, targets) {
  return Boolean(record)
    && targets.every(({ definition, relative }) => record.hooks?.some((hook) =>
      hook.event === definition.event && hook.path === relative));
}

function retentionLine(host) {
  const notice = retentionNotice(readRunConfig(path.join(host.agentsDir, 'run-config.json')));
  return notice.enabled ? `${WARNING}${notice.text}${RESET}` : notice.text;
}

function retentionOutput(line, output) {
  return `${output}\n${line}`;
}

async function installInRun({ host, dryRun = false, force = false, packageRoot } = {}) {
  // Validate the shared registry before writes; package removal on a broken registry left the host without its watchdog.
  await readRulesRegistry(host);
  const configuredRetentionLine = retentionLine(host);
  const plan = await buildInstallPlan(host, packageRoot);
  const rule = { ...rulesPlan(host, packageRoot), processing: 'copy' };
  const currentPackage = await packageInfo(packageRoot);
  const record = await readInstallRecord(host);
  const targets = hookTargets(host);
  for (const target of targets) {
    if (!plan.some((item) => item.relativeToHost === target.relative)) {
      throw new Error(`install plan does not contain hooks/${target.definition.file}`);
    }
  }
  const inspectedHooks = await Promise.all(targets.map(({ spec }) =>
    inspectHook(host.settingsPath, spec)));
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
      output: retentionOutput(configuredRetentionLine, `Conflicting files:\n${files}\nRun install again with --force to overwrite them.`),
    };
  }

  const changedFiles = states.filter((state) => !state.matches);
  const changedRule = !ruleState.matches;
  const sameRecord = recordMatchesPackage(record, plan, currentPackage,
    new Map(states.map((state) => [state.item.relativeToHost, state.fingerprint])),
    { path: rule.target, fingerprint: ruleState.fingerprint });
  if (!changedFiles.length && !changedRule && inspectedHooks.every((state) => state.present)
    && recordHasHooks(record, targets) && sameRecord) {
    if (!dryRun) await addRulesOwner(host);
    return { exitCode: 0, output: retentionOutput(configuredRetentionLine, 'codex-bridge is already installed; nothing to do.') };
  }

  if (dryRun) {
    const lines = changedFiles.map(({ item, exists }) =>
      `${exists ? 'Would overwrite' : 'Would create'} ${item.relativeToHost}`);
    if (changedRule) {
      lines.push(`${ruleState.exists ? 'Would overwrite' : 'Would create'} ${rule.target}`);
    }
    inspectedHooks.forEach((state, index) => {
      const { definition } = targets[index];
      lines.push(state.present
        ? `${definition.event} hook is already registered.`
        : `Would register ${definition.event} hook for matcher ${definition.matcher}.`);
    });
    lines.push('Would write installation record.');
    return { exitCode: 0, output: retentionOutput(configuredRetentionLine, lines.join('\n')) };
  }

  // Claim ownership of the shared rules file before writing anything. Claiming it last meant a
  // failure at that step left a fully installed host absent from the registry, and the next
  // uninstall elsewhere would then delete the rules out from under it.
  await addRulesOwner(host);
  for (const { item } of changedFiles) await copyPlannedFile(item, host.agentsDir);
  if (changedRule) await copyPlannedFile(rule, host.agentsDir);
  // Seeded files are written once and then belong to the operator: an existing one is left
  // exactly as it is, including under --force, because --force is about our files, not theirs.
  for (const seed of seedPlan(host, packageRoot)) {
    if (!(await targetExists(seed.target))) await copyPlannedFile(seed, host.agentsDir);
  }
  const hookResults = [];
  for (const { spec } of targets) hookResults.push(await mergeHook(host.settingsPath, spec));
  const fingerprints = Object.fromEntries(await Promise.all(plan.map(async (item) =>
    [item.relativeToHost, await fileFingerprint(item.target)])));
  const hooks = targets.map(({ definition, relative }, index) => {
    const prior = record?.hooks?.find((hook) => hook.event === definition.event);
    const createdGroup = hookResults[index].createdGroup || prior?.createdGroup === true;
    return createdGroup ? { event: definition.event, path: relative, createdGroup: true }
      : { event: definition.event, path: relative };
  });
  await writeInstallRecord(host, {
    ...currentPackage,
    installedAt: new Date().toISOString(),
    mode: 'copy',
    files: plan.map((item) => item.relativeToHost),
    fingerprints,
    rules: { path: rule.target, fingerprint: await fileFingerprint(rule.target) },
    hooks,
  });
  return {
    exitCode: 0,
    output: retentionOutput(configuredRetentionLine, `Installed ${plan.length + 1} files and registered the ${targets.map(({ definition }) => definition.event).join(' and ')} hooks.`),
  };
}

export async function install(options = {}) {
  const host = options?.host;
  if (!host?.settingsPath) return installInRun(options);
  return withSettingsRun(host.settingsPath, () => installInRun(options));
}
