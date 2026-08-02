/** Uninstalls only recorded codex-bridge files while preserving host data and foreign files. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { installRecordPath, readInstallRecord } from './manifest.mjs';
import { removeHook } from './settings-merge.mjs';

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

export async function uninstall({ host, dryRun = false } = {}) {
  const record = await readInstallRecord(host);
  const preservation = `Run artifacts in ${path.join(host.root, 'codex-runs')} are preserved.`;
  if (!record) return { exitCode: 1, output: `codex-bridge is not installed.\n${preservation}` };

  if (dryRun) {
    const lines = record.files.map((file) => `Would remove ${file}`);
    lines.push('Would remove the SubagentStop hook and installation record.');
    lines.push(preservation);
    return { exitCode: 0, output: lines.join('\n') };
  }

  await removeHook(host.settingsPath, path.join(host.root, record.hook.path), {
    createdGroup: record.hook.createdGroup === true,
  });
  for (const relative of record.files) {
    const target = path.join(host.root, relative);
    await fs.rm(target, { force: true });
    const boundary = target.startsWith(`${host.commandsDir}${path.sep}`) ? host.commandsDir : host.agentsDir;
    await removeEmptyParents(target, boundary);
  }
  await removeEmpty(host.commandsDir);
  await fs.rm(installRecordPath(host), { force: true });
  await removeEmpty(host.agentsDir);
  return { exitCode: 0, output: `Uninstalled codex-bridge.\n${preservation}` };
}
