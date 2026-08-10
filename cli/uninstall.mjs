/** Uninstalls only recorded files from both roots while preserving host data and foreign files. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  definitionForRecordedHook,
  fileFingerprint,
  installRecordPath,
  legacyInstallRecordPath,
  readInstallRecord,
  recordTarget,
} from './manifest.mjs';
import { removePermissionRules } from './permissions.mjs';
import {
  commandFor,
  removeHook,
  withSettingsRun,
} from './settings-merge.mjs';
import { readRulesRegistry, removeRulesOwner, remainingRulesOwners } from './rules-owners.mjs';
import {
  claudeBoundary,
  removeEmpty,
  removeEmptyLayout,
  removeEmptyParents,
} from './remove-layout.mjs';

function remainingOwnersText(count) {
  return `${count} other owner${count === 1 ? '' : 's'} ${count === 1 ? 'remains' : 'remain'}`;
}

function permissionOutput(host, removed, dryRun) {
  const verb = dryRun ? 'Would remove' : 'Removed';
  const plural = removed === 1 ? 'string' : 'strings';
  return `${verb} ${removed} permission rule ${plural} from ${host.settingsPath}.`;
}

function displayFile(file) {
  return `${file.root}/${file.path}`;
}

function hookRemovalSpec(host, hook) {
  const definition = definitionForRecordedHook(hook);
  const target = recordTarget(host, hook);
  const full = commandFor(target);
  const short = `codex-bridge hook ${definition.name}`;
  return {
    event: hook.event,
    matcher: definition.matcher,
    command: hook.command || full,
    alternateCommands: [full, short],
  };
}

async function uninstallInRun({ host, dryRun = false } = {}) {
  // Preflight before removing the hook: package removal on a broken registry left the host without its watchdog.
  let registry = null;
  let registryError = null;
  try {
    registry = await readRulesRegistry(host);
  } catch (err) {
    registryError = err;
  }
  const permissionResult = await removePermissionRules(host.settingsPath, { dryRun });
  const permissionLine = permissionOutput(host, permissionResult.removed, dryRun);
  const record = await readInstallRecord(host);
  const preservation = `Run artifacts in ${path.join(host.root, 'codex-runs')} and the run `
    + `configuration in ${host.brandConfigPath} are preserved.`;
  if (!record) {
    return { exitCode: 1, output: `${permissionLine}\ncodex-bridge is not installed.\n${preservation}` };
  }

  if (dryRun) {
    const lines = [permissionLine, ...record.files.map((file) => `Would remove ${displayFile(file)}`)];
    if (record.rules) {
      if (registryError) {
        lines.push(`Would leave ${record.rules.path} because the rules ownership registry is invalid; ownership is unknown.`);
      } else {
        const remainingOwners = remainingRulesOwners(registry, host);
        const currentFingerprint = await fileFingerprint(record.rules.path);
        if (remainingOwners?.length) {
          lines.push(`Would leave ${record.rules.path} because ${remainingOwnersText(remainingOwners.length)}.`);
        } else if (currentFingerprint === record.rules.fingerprint) {
          lines.push(`Would remove ${record.rules.path}; no other owners remain and its fingerprint is unchanged.`);
        } else if (currentFingerprint !== null) {
          lines.push(`Would leave ${record.rules.path} because its contents changed after installation.`);
        } else {
          lines.push(`Would leave ${record.rules.path} because it is already absent.`);
        }
        if (!registry) {
          lines.push(`Warning: the rules ownership registry was missing; other installations may use ${record.rules.path}.`);
        }
      }
    }
    for (const hook of record.hooks) {
      const definition = definitionForRecordedHook(hook);
      lines.push(`Would remove the ${hook.event} hook for matcher ${definition.matcher}.`);
    }
    lines.push('Would remove the installation record from the brand root.');
    lines.push(preservation);
    return { exitCode: 0, output: lines.join('\n') };
  }

  for (const hook of record.hooks) {
    await removeHook(host.settingsPath, hookRemovalSpec(host, hook), {
      createdGroup: hook.createdGroup === true,
    });
  }
  let ownership = null;
  if (!registryError) {
    try {
      ownership = await removeRulesOwner(host);
    } catch (err) {
      registryError = err;
    }
  }
  const rulesOutput = [];
  if (record.rules) {
    if (registryError) {
      rulesOutput.push(`Left ${record.rules.path} because the rules ownership registry is invalid; ownership is unknown.`);
    } else {
      if (ownership?.owners.length) {
        rulesOutput.push(`Left ${record.rules.path} because ${remainingOwnersText(ownership.owners.length)}.`);
      } else {
        const currentFingerprint = await fileFingerprint(record.rules.path);
        if (currentFingerprint === record.rules.fingerprint) {
          await fs.rm(record.rules.path, { force: true });
        } else if (currentFingerprint !== null) {
          rulesOutput.push(`Left ${record.rules.path} because its contents changed after installation.`);
        }
      }
      if (!registry) {
        rulesOutput.push(`Warning: the rules ownership registry was missing; other installations may use ${record.rules.path}.`);
      }
    }
  }
  for (const file of record.files) {
    const target = recordTarget(host, file);
    await fs.rm(target, { force: true });
    const boundary = file.root === 'brand'
      ? host.brandRoot
      : claudeBoundary(host, target);
    await removeEmptyParents(target, boundary);
  }
  await removeEmpty(host.commandsDir);
  await fs.rm(installRecordPath(host), { force: true });
  await fs.rm(legacyInstallRecordPath(host), { force: true });
  await removeEmpty(host.agentsDir);
  await removeEmptyLayout(host.legacyAgentsDir);
  await removeEmptyLayout(host.legacyCommandsDir);
  await removeEmpty(host.brandRoot);
  return {
    exitCode: 0,
    output: ['Uninstalled codex-bridge.', permissionLine, ...rulesOutput, preservation].join('\n'),
  };
}

export async function uninstall(options = {}) {
  const host = options?.host;
  if (!host?.settingsPath) return uninstallInRun(options);
  return withSettingsRun(host.settingsPath, () => uninstallInRun(options));
}
