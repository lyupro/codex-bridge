/**
 * Uninstalls one host and purges the package home behind one preflight.
 * Plan_65 D12 items 5-7 and D14 item 1 require both consents and authorization before any
 * host mutation; D10 item 4 forbids removing the home until this host's hooks are gone.
 */
import fs from 'node:fs';
import { uninstall, removePermissions, stillAttachedLine } from './uninstall.mjs';
import { legacyInstallRecordPath, readInstallRecord } from './manifest.mjs';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import { inspectHost } from './host-inspection.mjs';
import { removeHostSide } from './host-removal.mjs';
import { withSettingsRun } from './settings-merge.mjs';
import { withLifecycle } from './lifecycle-transaction.mjs';
import { readRulesRegistry } from './rules-owners.mjs';
import { rulesDryRunLines, removeRulesForHost } from './uninstall-rules.mjs';
import { removeEmpty, removeEmptyLayout } from './remove-layout.mjs';
import { recordHomeWriter, removeOutside } from './record-removal.mjs';
import { runPurgePreflight, diagnosePurge } from './purge-preflight.mjs';
import { executeHomePlan } from './home-plan-execute.mjs';
import {
  purgeDryRunLines, purgeDryRunExitCode, outcomeLines, outcomeExitCode,
} from './removal-outcomes.mjs';

async function purgeInRun(options, ticket) {
  const { host } = options;
  let registry = null;
  let registryError = null;
  try {
    registry = await readRulesRegistry(host);
  } catch (err) {
    registryError = err;
  }
  const preflight = await runPurgePreflight({
    host, ticket, packageRoot: options.packageRoot,
    ...(options.liveRunCheck !== undefined ? { liveRunCheck: options.liveRunCheck } : {}),
    options: { ...options, candidates: options.candidates ?? registry?.owners ?? [] },
  });
  if (preflight.verdict === 'refused') {
    return { exitCode: 1, output: ['Purge refused; nothing was changed.', ...preflight.lines].join('\n') };
  }
  if (preflight.verdict === 'cancelled') {
    return { exitCode: 130, output: 'Cancelled; nothing was changed.' };
  }
  const { plan, authorization } = preflight;
  const owner = plan.format2?.owners[normalizeRepoPath(host.root)] ?? null;
  const inspection = await inspectHost(host, { owner });
  const record = await readInstallRecord(host);
  const writer = record ? recordHomeWriter(host, record.files) : null;
  const permissionLine = await removePermissions(host, inspection, false);
  const hostSide = await removeHostSide(host, inspection, { owner });
  if (!hostSide.detached) {
    return {
      exitCode: 1,
      output: [stillAttachedLine(host), permissionLine, ...hostSide.lines,
        `Left ${host.brandRoot} untouched: purge removes the home only after this host's hooks are gone.`]
        .join('\n'),
    };
  }
  const rules = await removeRulesForHost({ host, record, registry, registryError, detached: true, writer });
  const { outcomes } = await executeHomePlan(host, plan, {
    detached: true, imageMembers: plan.imageMembers, authorization,
  });
  await removeEmpty(host.commandsDir);
  if (record) await removeOutside(writer, legacyInstallRecordPath(host));
  await removeEmpty(host.agentsDir);
  await removeEmptyLayout(host.legacyAgentsDir);
  await removeEmptyLayout(host.legacyCommandsDir);
  return {
    exitCode: outcomeExitCode(outcomes),
    output: ['Purged codex-bridge.', permissionLine, ...hostSide.lines, ...rules.lines,
      ...outcomeLines(outcomes, { host })].join('\n'),
  };
}

async function purgeDryRun(options) {
  const { host } = options;
  let registry = null;
  let registryError = null;
  try {
    registry = await readRulesRegistry(host);
  } catch (err) {
    registryError = err;
  }
  const diagnosis = await diagnosePurge({
    host, packageRoot: options.packageRoot,
    ...(options.liveRunCheck !== undefined ? { liveRunCheck: options.liveRunCheck } : {}),
  });
  // D12: a corrupt inventory is a diagnosis, never a throwing host-record read.
  const corrupt = diagnosis.plan.recordState === 'corrupt';
  const owner = corrupt ? null : diagnosis.plan.format2?.owners[normalizeRepoPath(host.root)] ?? null;
  const inspection = await inspectHost(host, { owner });
  const record = corrupt ? null : await readInstallRecord(host);
  const permissionLine = await removePermissions(host, inspection, true);
  const hostSide = await removeHostSide(host, inspection, { owner, dryRun: true });
  const lines = [permissionLine, ...hostSide.lines];
  if (!hostSide.detached) {
    lines.push(`Would leave ${host.brandRoot} untouched: this host's hooks could not be removed.`);
  }
  lines.push(...await rulesDryRunLines({ host, record, registry, registryError, detached: hostSide.detached }));
  lines.push(...purgeDryRunLines(diagnosis, { host }));
  return { exitCode: hostSide.detached ? purgeDryRunExitCode(diagnosis) : 1, output: lines.join('\n') };
}

async function missingHome(options) {
  const result = await uninstall(options);
  return { ...result, output: `${result.output}\nNothing to purge: ${options.host.brandRoot} does not exist.` };
}

export async function purge(options) {
  const { host } = options;
  if (options.dryRun) return withSettingsRun(host.settingsPath, () => purgeDryRun(options));
  if (!fs.existsSync(host.brandRoot)) return missingHome(options);
  return withLifecycle(host, 'purge', (ticket) => {
    if (ticket === undefined) return missingHome(options);
    return withSettingsRun(host.settingsPath, () => purgeInRun(options, ticket));
  }, { waitMs: options.lifecycleWaitMs });
}
