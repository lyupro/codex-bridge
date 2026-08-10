/** Installs codex-bridge files into the Claude and brand roots with conflict-safe idempotency. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildInstallPlan,
  fileFingerprint,
  HOOK_DEFINITIONS,
  installedHookPath,
  packageInfo,
  recordFileKey,
  readInstallRecord,
  recordMatchesPackage,
  rulesPlan,
  seedPlan,
  writeInstallRecord,
} from './manifest.mjs';
import { copyPlannedFile, targetMatches } from './copy.mjs';
import { fingerprintFor } from './install-record.mjs';
import {
  commandFor,
  hookRegistration,
  inspectHook,
  mergeHook,
  withSettingsRun,
} from './settings-merge.mjs';
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

function hookTargets(host, env = process.env) {
  return HOOK_DEFINITIONS.map((definition) => {
    const target = installedHookPath(host, definition);
    const registration = hookRegistration(definition.name, target, env);
    const fallback = commandFor(target);
    const alternate = registration.command === fallback
      ? `codex-bridge hook ${definition.name}`
      : fallback;
    return {
      definition,
      target,
      root: 'brand',
      relative: path.relative(host.brandRoot, target).split(path.sep).join('/'),
      registration,
      spec: {
        event: definition.event,
        matcher: definition.matcher,
        command: registration.command,
        alternateCommands: [alternate],
      },
    };
  });
}

function recordHasHooks(record, targets) {
  return Boolean(record)
    && targets.every(({ definition, relative }) => record.hooks?.some((hook) =>
      hook.event === definition.event && hook.root === 'brand' && hook.path === relative));
}

function retentionLine(host) {
  const notice = retentionNotice(readRunConfig(host.brandConfigPath));
  return notice.enabled ? `${WARNING}${notice.text}${RESET}` : notice.text;
}

function retentionOutput(line, output) {
  return `${output}\n${line}`;
}

async function migrateLegacySeed(host, seed) {
  if (await targetExists(seed.target)) return;
  const legacyName = path.basename(seed.target) === 'config.json' ? 'run-config.json' : path.basename(seed.target);
  const legacy = path.join(host.agentsDir, legacyName);
  if (legacy === seed.target || !(await targetExists(legacy))) return;
  // Existing seeded files hold operator decisions. Copying a legacy one to the new root preserves
  // those decisions during Plan_25 migration; the old copy is deliberately left untouched because
  // seeded files are never removed by the installer.
  await fs.mkdir(path.dirname(seed.target), { recursive: true });
  await fs.copyFile(legacy, seed.target);
}

async function installInRun({ host, dryRun = false, force = false, packageRoot, env = process.env } = {}) {
  // Validate the shared registry before writes; package removal on a broken registry left the host without its watchdog.
  await readRulesRegistry(host);
  const configuredRetentionLine = retentionLine(host);
  const plan = await buildInstallPlan(host, packageRoot);
  const rule = { ...rulesPlan(host, packageRoot), processing: 'copy' };
  const currentPackage = await packageInfo(packageRoot);
  const record = await readInstallRecord(host);
  const targets = hookTargets(host, env);
  for (const target of targets) {
    if (!plan.some((item) => item.root === 'brand' && item.relativeToRoot === target.relative)) {
      throw new Error(`install plan does not contain hooks/${target.definition.file}`);
    }
  }
  const inspectedHooks = await Promise.all(targets.map(({ spec }) =>
    inspectHook(host.settingsPath, spec)));
  const states = await Promise.all(plan.map(async (item) => ({
    item,
    exists: await targetExists(item.target),
    matches: await targetMatches(item, host.brandRoot),
    fingerprint: await fileFingerprint(item.target),
  })));
  const ruleState = {
    item: rule,
    exists: await targetExists(rule.target),
    matches: await targetMatches(rule, host.brandRoot),
    fingerprint: await fileFingerprint(rule.target),
  };
  const conflicts = [
    ...states.filter((state) => state.exists && !state.matches
      && (!record || (record.fingerprints
        && fingerprintFor(record, state.item) !== state.fingerprint))),
    ...(ruleState.exists && !ruleState.matches
      && (!record?.rules || record.rules.fingerprint !== ruleState.fingerprint) ? [ruleState] : []),
  ];
  if (conflicts.length && !force) {
    const files = conflicts.map(({ item }) => `  ${item.relativeToRoot || item.name}`).join('\n');
    return {
      exitCode: 1,
      output: retentionOutput(configuredRetentionLine, `Conflicting files:\n${files}\nRun install again with --force to overwrite them.`),
    };
  }

  const changedFiles = states.filter((state) => !state.matches);
  const changedRule = !ruleState.matches;
  const sameRecord = recordMatchesPackage(record, plan, currentPackage,
    new Map(states.map((state) => [recordFileKey(state.item), state.fingerprint])),
    { path: rule.target, fingerprint: ruleState.fingerprint });
  if (!changedFiles.length && !changedRule && inspectedHooks.every((state) => state.present)
    && recordHasHooks(record, targets) && sameRecord) {
    if (!dryRun) await addRulesOwner(host);
    return { exitCode: 0, output: retentionOutput(configuredRetentionLine, 'codex-bridge is already installed; nothing to do.') };
  }

  if (dryRun) {
    const lines = changedFiles.map(({ item, exists }) =>
      `${exists ? 'Would overwrite' : 'Would create'} ${item.root}/${item.relativeToRoot}`);
    if (changedRule) {
      lines.push(`${ruleState.exists ? 'Would overwrite' : 'Would create'} ${rule.target}`);
    }
    inspectedHooks.forEach((state, index) => {
      const { definition, registration } = targets[index];
      lines.push(state.present
        ? `${definition.event} hook is already registered (${registration.form} command).`
        : `Would register ${definition.event} hook for matcher ${definition.matcher} with ${registration.form} command.`);
    });
    lines.push('Would write installation record in the brand root.');
    return { exitCode: 0, output: retentionOutput(configuredRetentionLine, lines.join('\n')) };
  }

  // Claim ownership of the shared rules file before writing anything. Claiming it last meant a
  // failure at that step left a fully installed host absent from the registry, and the next
  // uninstall elsewhere would then delete the rules out from under it.
  await addRulesOwner(host);
  for (const { item } of changedFiles) await copyPlannedFile(item, host.brandRoot);
  if (changedRule) await copyPlannedFile(rule, host.brandRoot);
  // Seeded files are written once and then belong to the operator: an existing one is left
  // exactly as it is, including under --force, because --force is about our files, not theirs.
  for (const seed of seedPlan(host, packageRoot)) {
    if (!(await targetExists(seed.target))) {
      await migrateLegacySeed(host, seed);
      if (!(await targetExists(seed.target))) await copyPlannedFile(seed, host.brandRoot);
    }
  }
  const hookResults = [];
  for (const { spec } of targets) hookResults.push(await mergeHook(host.settingsPath, spec));
  const fingerprints = {};
  for (const item of plan) {
    fingerprints[item.root] ??= {};
    fingerprints[item.root][item.relativeToRoot] = await fileFingerprint(item.target);
  }
  const hooks = targets.map(({ definition, relative, registration }, index) => {
    const prior = record?.hooks?.find((hook) => hook.event === definition.event
      && hook.root === 'brand' && hook.path === relative);
    const createdGroup = hookResults[index].createdGroup || prior?.createdGroup === true;
    const command = inspectedHooks[index].matchedCommand || registration.command;
    return {
      event: definition.event,
      root: 'brand',
      path: relative,
      command,
      form: command.startsWith('codex-bridge hook ') ? 'short' : 'path',
      ...(createdGroup ? { createdGroup: true } : {}),
    };
  });
  await writeInstallRecord(host, {
    ...currentPackage,
    installedAt: new Date().toISOString(),
    mode: 'copy',
    files: plan.map((item) => ({ root: item.root, path: item.relativeToRoot })),
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
