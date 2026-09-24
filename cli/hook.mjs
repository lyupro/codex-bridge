/** Dispatches a named host hook from the installed brand home. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveBrandHome } from '../src/home/lib/brand-home.mjs';

export const HOOK_LAUNCHER_PROTOCOL = 1;

function reportFailure(io, name, reason) {
  io.error(`codex-bridge hook: guard "${name}" did not run: ${reason}. Run codex-bridge doctor.`);
  return 1;
}

export async function hook(args = [], io = console) {
  if (!Array.isArray(args) || args.length !== 1) {
    io.error('Usage: codex-bridge hook <name> | codex-bridge hook --home');
    return 1;
  }

  const home = resolveBrandHome({ homedir: os.homedir(), env: process.env });
  if (args[0] === '--home') {
    io.log(JSON.stringify({ protocol: HOOK_LAUNCHER_PROTOCOL, dispatch: 'home', homeRoot: home.root }));
    return 0;
  }
  if (!args[0] || args[0].startsWith('-')) {
    io.error('Usage: codex-bridge hook <name> | codex-bridge hook --home');
    return 1;
  }

  const name = args[0];
  const entry = path.join(home.root, 'lib', 'hook-entry.mjs');
  if (!fs.existsSync(entry)) {
    io.error(`codex-bridge hook: guard "${name}" did not run: codex-bridge is not installed in ${home.root}. Run codex-bridge install.`);
    return 1;
  }
  try {
    const { runHook } = await import(pathToFileURL(entry).href);
    return await runHook(name, io);
  } catch (error) {
    return reportFailure(io, name, error?.message ?? String(error));
  }
}
