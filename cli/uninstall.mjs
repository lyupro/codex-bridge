/** Uninstalls only recorded codex-bridge files while preserving host data and foreign files. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileFingerprint, installRecordPath, readInstallRecord } from './manifest.mjs';
import { removeHook } from './settings-merge.mjs';
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

export async function uninstall({ host, dryRun = false } = {}) {
  const record = await readInstallRecord(host);
  const preservation = `Run artifacts in ${path.join(host.root, 'codex-runs')} and the run `
    + `configuration in ${path.join(host.agentsDir, 'run-config.json')} are preserved.`;
  if (!record) return { exitCode: 1, output: `codex-bridge is not installed.\n${preservation}` };

  if (dryRun) {
    const lines = record.files.map((file) => `Would remove ${file}`);
    if (record.rules) {
      const registry = await readRulesRegistry(host);
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
    }
    lines.push('Would remove the SubagentStop hook and installation record.');
    lines.push(preservation);
    return { exitCode: 0, output: lines.join('\n') };
  }

  await removeHook(host.settingsPath, path.join(host.root, record.hook.path), {
    createdGroup: record.hook.createdGroup === true,
  });
  const ownership = await removeRulesOwner(host);
  let rulesOutput;
  if (record.rules) {
    if (ownership?.owners.length) {
      rulesOutput = `Left ${record.rules.path} because ${remainingOwnersText(ownership.owners.length)}.`;
    } else {
      const currentFingerprint = await fileFingerprint(record.rules.path);
      if (currentFingerprint === record.rules.fingerprint) {
        await fs.rm(record.rules.path, { force: true });
      } else if (currentFingerprint !== null) {
        rulesOutput = `Left ${record.rules.path} because its contents changed after installation.`;
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
    output: [`Uninstalled codex-bridge.`, rulesOutput, preservation].filter(Boolean).join('\n'),
  };
}
