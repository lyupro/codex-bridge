/** Updates a recorded installation without overwriting unapproved host changes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { install } from './install.mjs';
import {
  buildInstallPlan,
  fileFingerprint,
  HOOK_DEFINITIONS,
  installedHookPath,
  legacyInstallRecordPath,
  packageInfo,
  recordFileKey,
  readInstallRecord,
  recordMatchesPackage,
  recordTarget,
  rulesPlan,
} from './manifest.mjs';
import { targetMatches } from './copy.mjs';
import { definitionForRecordedHook, fileEntry, fingerprintFor } from './install-record.mjs';
import {
  commandFor,
  hookRegistration,
  inspectHook,
  removeHook,
  withSettingsRun,
} from './settings-merge.mjs';
import { addRulesOwner, readRulesRegistry } from './rules-owners.mjs';
import { claudeBoundary, removeEmptyLayout, removeEmptyParents } from './remove-layout.mjs';

async function exists(target) {
  try {
    return (await fs.stat(target)).isFile();
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
}

/** Drops the previous layout's record and its emptied directories; safe to run when both are gone. */
async function retireLegacyLayout(host) {
  await fs.rm(legacyInstallRecordPath(host), { force: true });
  await removeEmptyLayout(host.legacyAgentsDir);
  await removeEmptyLayout(host.legacyCommandsDir);
}

function displayFile(file) {
  const entry = fileEntry(file);
  return `${entry.root}/${entry.path}`;
}

function classifyPlanned(state) {
  if (!state.recorded) return 'new';
  if (!state.exists) return 'missing';
  if (state.matchesPackage) return 'up-to-date';
  if (state.recordedFingerprint === state.fingerprint) return 'outdated';
  return 'modified';
}

function classifyOrphan(state) {
  if (!state.exists) return 'orphaned';
  if (state.recordedFingerprint === state.fingerprint) return 'orphaned';
  return 'modified';
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

function appliedOutput(states) {
  const count = (status) => states.filter((state) => state.status === status).length;
  const parts = [
    [count('outdated'), 'updated'],
    [count('new'), 'added'],
    [count('missing'), 'restored'],
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

function dryRunOutput(states, hookStates, legacy, oldHooks) {
  const lines = [];
  for (const state of states) {
    if (state.status === 'outdated') lines.push(`Would update ${state.relative}.`);
    if (state.status === 'new') lines.push(`Would create ${state.relative}.`);
    if (state.status === 'modified' && state.item) lines.push(`Would overwrite ${state.relative}.`);
    if (state.status === 'missing') lines.push(`Would restore ${state.relative}.`);
    if (state.status === 'orphaned' && state.exists) lines.push(`Would remove ${state.relative}.`);
    if (state.status === 'modified' && !state.item) lines.push(`Would preserve modified orphan ${state.relative}.`);
  }
  oldHooks.forEach((hook) => lines.push(`Would remove the previous ${hook.event} hook registration.`));
  hookStates.forEach(({ state, target }) => {
    const { definition, registration } = target;
    if (!state.present) {
      lines.push(`Would register ${definition.event} hook for matcher ${definition.matcher} with ${registration.form} command.`);
    }
  });
  lines.push('Would write installation record with new fingerprints in both roots.');
  if (legacy && states.some((state) => state.status === 'modified')) {
    lines.push('Installation record has no fingerprints; differing files are treated as modified.');
  }
  return lines.join('\n');
}

function previousHooks(host, record, targets) {
  return record.hooks.filter((hook) => {
    const current = targets.find(({ definition, relative }) =>
      definition.event === hook.event && hook.root === 'brand' && relative === hook.path);
    return !current;
  }).map((hook) => {
    const definition = definitionForRecordedHook(hook);
    const target = recordTarget(host, hook);
    return {
      hook,
      definition,
      spec: {
        event: hook.event,
        matcher: definition.matcher,
        command: hook.command || commandFor(target),
        alternateCommands: [commandFor(target), `codex-bridge hook ${definition.name}`],
      },
    };
  });
}

async function updateInRun({ host, dryRun = false, force = false, packageRoot, env = process.env } = {}) {
  await readRulesRegistry(host);
  const record = await readInstallRecord(host);
  if (!record) {
    return { exitCode: 1, output: 'codex-bridge is not installed. Run codex-bridge install first.' };
  }

  const plan = await buildInstallPlan(host, packageRoot);
  const rule = { ...rulesPlan(host, packageRoot), processing: 'copy' };
  const planned = new Map(plan.map((item) => [recordFileKey(item), item]));
  const plannedStates = await Promise.all(plan.map(async (item) => {
    const relative = displayFile(item);
    const targetExists = await exists(item.target);
    const state = {
      relative,
      item,
      recorded: record.files.some((file) => recordFileKey(file) === recordFileKey(item)),
      recordedFingerprint: fingerprintFor(record, item),
      exists: targetExists,
      matchesPackage: targetExists && await targetMatches(item, host.brandRoot),
      fingerprint: targetExists ? await fileFingerprint(item.target) : null,
    };
    return { ...state, status: classifyPlanned(state) };
  }));
  const ruleExists = await exists(rule.target);
  const ruleState = {
    relative: rule.target,
    item: rule,
    recorded: Boolean(record.rules),
    recordedFingerprint: record.rules?.fingerprint,
    exists: ruleExists,
    matchesPackage: ruleExists && await targetMatches(rule, host.brandRoot),
    fingerprint: ruleExists ? await fileFingerprint(rule.target) : null,
  };
  ruleState.status = classifyPlanned(ruleState);
  const orphanStates = await Promise.all(record.files
    .filter((file) => !planned.has(recordFileKey(file)))
    .map(async (file) => {
      const target = recordTarget(host, file);
      const targetExists = await exists(target);
      const state = {
        relative: displayFile(file),
        entry: fileEntry(file),
        item: null,
        exists: targetExists,
        recordedFingerprint: fingerprintFor(record, file),
        fingerprint: targetExists ? await fileFingerprint(target) : null,
      };
      return { ...state, status: classifyOrphan(state) };
    }));
  const states = [...plannedStates, ruleState, ...orphanStates];
  const conflicts = states.filter((state) => state.status === 'modified' || state.status === 'missing');
  const legacy = !record.fingerprints;
  if (conflicts.length && !force) {
    return { exitCode: 1, output: conflictOutput(conflicts, legacy, dryRun) };
  }

  const targets = hookTargets(host, env);
  const inspectedHooks = await Promise.all(targets.map(async (target) => ({
    target,
    state: await inspectHook(host.settingsPath, target.spec),
  })));
  const oldHooks = previousHooks(host, record, targets);
  const currentPackage = await packageInfo(packageRoot);
  const recordCurrent = recordMatchesPackage(record, plan, currentPackage,
    new Map(plannedStates.map((state) => [recordFileKey(state.item), state.fingerprint])),
    { path: rule.target, fingerprint: ruleState.fingerprint });
  const changed = states.some((state) => state.status !== 'up-to-date') || oldHooks.length > 0;
  if (!changed && inspectedHooks.every(({ state }) => state.present)
    && recordHasHooks(record, targets) && recordCurrent) {
    if (!dryRun) {
      await addRulesOwner(host);
      // An update that installed the new layout but stopped before retiring the old one used to
      // land here forever after: everything it compares is current, so it reported "up to date"
      // while agents/codex sat next to agents/codex-bridge. Retirement is idempotent, so running
      // it on this path costs nothing when there is nothing left to retire.
      await retireLegacyLayout(host);
    }
    return { exitCode: 0, output: 'codex-bridge is up to date' };
  }
  if (dryRun) {
    return { exitCode: 0, output: dryRunOutput(states, inspectedHooks, legacy, oldHooks) };
  }

  for (const state of orphanStates) {
    if (state.status !== 'orphaned' || !state.exists) continue;
    const target = recordTarget(host, state.entry);
    await fs.rm(target, { force: true });
    const boundary = state.entry.root === 'brand' ? host.brandRoot : claudeBoundary(host, target);
    await removeEmptyParents(target, boundary);
  }
  for (const { spec, hook } of oldHooks) {
    await removeHook(host.settingsPath, spec, { createdGroup: hook.createdGroup === true });
  }
  const installed = await install({ host, force: true, packageRoot, env });
  if (installed.exitCode !== 0) return installed;
  await retireLegacyLayout(host);
  return { exitCode: 0, output: appliedOutput(states) };
}

export async function update(options = {}) {
  const host = options?.host;
  if (!host?.settingsPath) return updateInRun(options);
  return withSettingsRun(host.settingsPath, () => updateInRun(options));
}
