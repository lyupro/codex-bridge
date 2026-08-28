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
import { hookTargets } from './hook-targets.mjs';
import { fingerprintFor } from './install-record.mjs';
import {
  commandFor,
  hookRegistration,
  inspectHook,
  mergeHook,
  withSettingsRun,
} from './settings-merge.mjs';
import { addRulesOwner, readRulesRegistry } from './rules-owners.mjs';
import { addPermissionRules, inspectPermissions } from './permissions.mjs';
import { contractStatus, detectHostVersion, readHostContract } from './host-contract.mjs';
import { readRunConfig, retentionNotice } from '../src/home/lib/run-config.mjs';

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

function contractOutput(status, output) {
  return status.state === 'verified' ? output : `${output}\n${status.message}`;
}

function naturalList(items) {
  if (items.length < 2) return items.join('');
  return items.length === 2
    ? items.join(' and ')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function hookSummary(targets) {
  const counts = new Map();
  for (const { definition } of targets) {
    counts.set(definition.event, (counts.get(definition.event) || 0) + 1);
  }
  const events = [...counts].map(([event, count]) => `${count} ${event}`);
  return `${targets.length} hooks: ${naturalList(events)}`;
}

function permissionOutput(result, settingsPath) {
  if (result.dryRun) return `Would evaluate permission rules in ${settingsPath}; settings unchanged.`;
  if (result.added > 0) {
    return `Granted ${result.added} of ${result.total} permission rule(s) in ${settingsPath} so the host runs the package command without asking.`;
  }
  // Zero granted is the good outcome only when the whole set is there. Saying "all are in place"
  // off the count of what was added would state the opposite of the truth on a host someone had
  // edited by hand, and permission windows are exactly what the operator would then not understand.
  if (result.present < result.total) {
    return `${result.present} of ${result.total} permission rules are in place in ${settingsPath}; run codex-bridge install --force to restore the rest.`;
  }
  return `All ${result.total} permission rules are already in place in ${settingsPath}, so the host runs the package command without asking.`;
}

async function migrateLegacySeed(host, seed) {
  if (await targetExists(seed.target)) return;
  const legacyName = path.basename(seed.target) === 'config.json' ? 'run-config.json' : path.basename(seed.target);
  const legacy = path.join(host.legacyAgentsDir, legacyName);
  if (legacy === seed.target || !(await targetExists(legacy))) return;
  // Existing seeded files hold operator decisions, so Plan_25 moves them rather than reading a
  // fresh default: copy first, compare the bytes, and only then drop the old path. Leaving the old
  // copy behind — the first version of this migration did — keeps agents/codex non-empty forever,
  // so the previous layout is never taken down and the operator goes on editing a file nothing
  // reads. If the comparison fails the old file stays: a half-copied config is the one case where
  // having two is better than having none.
  await fs.mkdir(path.dirname(seed.target), { recursive: true });
  await fs.copyFile(legacy, seed.target);
  if (await fileFingerprint(legacy) !== await fileFingerprint(seed.target)) return;
  await fs.rm(legacy, { force: true });
}

async function installInRun({
  host,
  dryRun = false,
  force = false,
  packageRoot,
  env = process.env,
  contractRecord,
  hostVersion,
} = {}) {
  // Validate the shared registry before writes; package removal on a broken registry left the host without its watchdog.
  await readRulesRegistry(host);
  const configuredRetentionLine = retentionLine(host);
  const hostContract = contractStatus({
    record: contractRecord === undefined ? await readHostContract(host) : contractRecord,
    version: hostVersion === undefined ? detectHostVersion() : hostVersion,
  });
  const plan = await buildInstallPlan(host, packageRoot);
  const rule = { ...rulesPlan(host, packageRoot), processing: 'copy' };
  const currentPackage = await packageInfo(packageRoot);
  const record = await readInstallRecord(host);
  const targets = hookTargets(host, env, currentPackage.version);
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
      output: contractOutput(hostContract, retentionOutput(configuredRetentionLine, `Conflicting files:\n${files}\nRun install again with --force to overwrite them.`)),
    };
  }

  const changedFiles = states.filter((state) => !state.matches);
  const changedRule = !ruleState.matches;
  const sameRecord = recordMatchesPackage(record, plan, currentPackage,
    new Map(states.map((state) => [recordFileKey(state.item), state.fingerprint])),
    { path: rule.target, fingerprint: ruleState.fingerprint });
  if (!changedFiles.length && !changedRule && inspectedHooks.every((state) => state.present)
    && recordHasHooks(record, targets) && sameRecord) {
    if (!dryRun) {
      await addRulesOwner(host);
      // Read, never write: this branch's whole claim is that there is nothing to do, and a
      // sentence about permission rules must not be paid for by quietly restoring one.
      const permissionResult = await inspectPermissions(host.settingsPath);
      return {
        exitCode: 0,
        output: contractOutput(
          hostContract,
          retentionOutput(
            configuredRetentionLine,
            `codex-bridge is already installed; nothing to do.\n${permissionOutput(permissionResult, host.settingsPath)}`,
          ),
        ),
      };
    }
    return {
      exitCode: 0,
      output: contractOutput(hostContract, retentionOutput(configuredRetentionLine, 'codex-bridge is already installed; nothing to do.')),
    };
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
    return { exitCode: 0, output: contractOutput(hostContract, retentionOutput(configuredRetentionLine, lines.join('\n'))) };
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
  // Uninstall has always removed these rules, and install never granted them — so removal took
  // away what installation never gave. Without the rule the host refuses the package command,
  // and the 2026-08-15 `cartoons-r136-scout-lock-scope` order shows what a dispatcher does next:
  // it goes looking for a way around, down to the absolute path to run-codex.mjs that Plan_41
  // removed. The rule follows the scope of the install, because host.settingsPath already is the
  // scope — a --scope project install must not reach into the operator's global config.
  const permissionResult = dryRun
    ? { dryRun: true, added: 0, present: 0, total: 0 }
    : await addPermissionRules(host.settingsPath);
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
    output: contractOutput(
      hostContract,
      retentionOutput(
        configuredRetentionLine,
        `Installed ${plan.length} files and the Codex rules file, and registered ${hookSummary(targets)}.`
          + `\n${permissionOutput(permissionResult, host.settingsPath)}`,
      ),
    ),
  };
}

export async function install(options = {}) {
  const host = options?.host;
  if (!host?.settingsPath) return installInRun(options);
  return withSettingsRun(host.settingsPath, () => installInRun(options));
}
