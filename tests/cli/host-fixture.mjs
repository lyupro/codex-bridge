/** Builds the throwaway host both the install and uninstall suites work against. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';

export async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    host: resolveHost({ host: path.join(root, 'host'), codexHome: path.join(root, 'codex-home') }),
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
