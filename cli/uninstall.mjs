/** Uninstalls only recorded files from both roots while preserving host data and foreign files. */
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
import { hostContractPath } from './host-contract.mjs';
import { brandStateDir } from '../src/home/lib/brand-home.mjs';
import {
  commandFor,
  removeHook,
  withSettingsRun,
} from './settings-merge.mjs';
import { readRulesRegistry, removeRulesOwner, remainingRulesOwners } from './rules-owners.mjs';
import { removeEmpty, removeEmptyLayout } from './remove-layout.mjs';
import { recordHomeWriter, removeOutside, removeRecordedFile } from './record-removal.mjs';

function remainingOwnersText(count) {
  return `${count} other owner${count === 1 ? '' : 's'} ${count === 1 ? 'remains' : 'remain'}`;
}

function permissionOutput(host, removed, dryRun) {
  const verb = dryRun ? 'Would remove' : 'Removed';
  const plural = removed === 1 ? 'string' : 'strings';
  return `${verb} ${removed} permission rule ${plural} from ${host.settingsPath}.`;
}

// Plan_62 D22: uninstall removes only recorded files, and the message used to name only runs and
// config.json — state/, the host measurement and conventions.md stayed behind unmentioned. Until
// Plan_65 derives this from a registry, the sentence names every kind the package writes while working.
function preservationText(host) {
  return `Run artifacts in ${path.join(host.root, 'codex-runs')} are preserved, and so is what the package `
    + `wrote into ${host.brandRoot} while working: the run configuration ${host.brandConfigPath}, the conventions `
    + `${host.brandConventionsPath}, the host measurement ${hostContractPath(host)} and runtime state in `
    + `${brandStateDir(host.brandRoot)} (dispatcher state, guard counters, the handback witness, the host `
    + 'observations, dispatcher contract verdicts, and hook diagnostics that hold the full hook input). Delete them by '
    + 'hand for a complete removal.';
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
  const preservation = preservationText(host);
  if (!record) {
    return { exitCode: 1, output: `${permissionLine}\ncodex-bridge is not installed.\n${preservation}` };
  }
  const writer = recordHomeWriter(host, record.files);

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
      lines.push(`Would remove the ${hook.event} hook ${definition.name} for matcher ${definition.matcher}.`);
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
          await removeOutside(writer, record.rules.path);
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
    await removeRecordedFile(host, writer, file);
  }
  await removeEmpty(host.commandsDir);
  try {
    await writer.unlink('install-record', installRecordPath(host));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await removeOutside(writer, legacyInstallRecordPath(host));
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
