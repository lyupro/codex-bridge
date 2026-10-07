/** Builds the throwaway host both the install and uninstall suites work against. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { installRecordPath } from '../../cli/install-record.mjs';
import { ownerView } from '../../cli/install-owners.mjs';
import { isFormat2 } from '../../src/home/lib/install-owner-roots.mjs';

export async function fixture(t) {
  const root = makeTempTree('bridge-install-');
  t.after(() => removeTempTree(root));
  return {
    root,
    host: resolveHost({
      host: path.join(root, 'host'),
      codexHome: path.join(root, 'codex-home'),
      brandRoot: path.join(root, 'brand'),
    }),
  };
}

export async function allFiles(root) {
  const found = [];
  try {
    for await (const entry of fs.glob('**', { cwd: root })) {
      if ((await fs.stat(path.join(root, entry))).isFile()) found.push(entry.split(path.sep).join('/'));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return found.sort();
}

/**
 * The record as installers before format 2 wrote it. Tests that simulate an old record edit this
 * shape and write it back, so the file on disk really is format 1 — not a format-2 file carrying
 * a second, top-level copy of one owner for the tests to reach (Plan_65 B13b).
 */
export async function formatOneRecord(host) {
  const parsed = JSON.parse(await fs.readFile(installRecordPath(host), 'utf8'));
  return isFormat2(parsed) ? ownerView(parsed, host) : parsed;
}
