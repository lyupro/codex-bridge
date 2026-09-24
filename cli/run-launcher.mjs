/** Loads the installed runner because Plan_62 D17 makes the brand home the runtime source of truth. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveBrandHome } from '../src/home/lib/brand-home.mjs';

export async function runCodex(args = [], io = console) {
  const home = resolveBrandHome({ homedir: os.homedir(), env: process.env });
  const entry = path.join(home.root, 'lib', 'run-codex.mjs');
  if (!fs.existsSync(entry)) {
    io.error(`codex-bridge run: codex-bridge is not installed in ${home.root}. Run codex-bridge install.`);
    return 1;
  }
  const { runCodexCommand } = await import(pathToFileURL(entry).href);
  return runCodexCommand(args);
}
