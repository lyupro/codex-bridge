/** Uninstalls only recorded codex-bridge files while preserving host data and foreign files. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  definitionForRecordedHook,
  fileFingerprint,
  installRecordPath,
  readInstallRecord,
} from './manifest.mjs';
import { removePermissionRules } from './permissions.mjs';
import { commandFor, removeHook, withSettingsRun } from './settings-merge.mjs';
import { readRulesRegistry, removeRulesOwner, remainingRulesOwners } from './rules-owners.mjs';

async function removeEmpty(directory) {
  try {
    if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function removeEmptyParents(target, boundary) {
  let current = path.dirname(target);
  while (current !== boundary && current.startsWith(`${boundary}${path.sep}`)) {
    await removeEmpty(current);
    current = path.dirname(current);
  }
}

function remainingOwnersText(count) {
  return `${count} other owner${count === 1 ? '' : 's'} ${count === 1 ? 'remains' : 'remain'}`;
}

function permissionOutput(host, removed, dryRun) {
  const verb = dryRun ? 'Would remove' : 'Removed';
  const plural = removed === 1 ? 'string' : 'strings';
  return `${verb} ${removed} permission rule ${plural} from ${host.settingsPath}.`;
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
    + `configuration in ${path.join(host.agentsDir, 'run-config.json')} are preserved.`;
  if (!record) {
    return { exitCode: 1, output: `${permissionLine}\ncodex-bridge is not installed.\n${preservation}` };
  }

  if (dryRun) {
    const lines = [permissionLine, ...record.files.map((file) => `Would remove ${file}`)];
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
    lines.push('Would remove the installation record.');
    lines.push(preservation);
    return { exitCode: 0, output: lines.join('\n') };
  }

  for (const hook of record.hooks) {
    const definition = definitionForRecordedHook(hook);
    const target = path.join(host.root, hook.path);
    await removeHook(host.settingsPath, {
      event: hook.event,
      matcher: definition.matcher,
      command: commandFor(target),
    }, { createdGroup: hook.createdGroup === true });
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
  for (const relative of record.files) {
    const target = path.join(host.root, relative);
    await fs.rm(target, { force: true });
    const boundary = target.startsWith(`${host.commandsDir}${path.sep}`) ? host.commandsDir : host.agentsDir;
    await removeEmptyParents(target, boundary);
  }
  await removeEmpty(host.commandsDir);
  await fs.rm(installRecordPath(host), { force: true });
  await removeEmpty(host.agentsDir);
  return {
    exitCode: 0,
    output: [`Uninstalled codex-bridge.`, permissionLine, ...rulesOutput, preservation].join('\n'),
  };
}

export async function uninstall(options = {}) {
  const host = options?.host;
  if (!host?.settingsPath) return uninstallInRun(options);
  return withSettingsRun(host.settingsPath, () => uninstallInRun(options));
}
