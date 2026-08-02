#!/usr/bin/env node
/** Dispatches codex-bridge CLI arguments to focused command modules. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose, renderDoctor } from '../cli/doctor.mjs';
import { resolveHost } from '../cli/hosts.mjs';
import { packageInfo } from '../cli/manifest.mjs';

export const HELP = `codex-bridge — Claude Code dispatchers for Codex

Usage:
  codex-bridge doctor [--scope user|project] [--host <path>]
  codex-bridge --help
  codex-bridge --version

Commands:
  doctor    Diagnose the selected Claude Code host`;

function doctorOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--scope' && arg !== '--host') throw new Error(`unknown doctor option "${arg}"`);
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
    options[arg === '--scope' ? 'scope' : 'host'] = value;
    index += 1;
  }
  return options;
}

export async function main(argv, io = console) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    io.log(HELP);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    io.log((await packageInfo()).version);
    return 0;
  }
  if (command === 'doctor') {
    const host = resolveHost(doctorOptions(rest));
    const result = await diagnose({ host });
    io.log(renderDoctor(result));
    return result.exitCode;
  }
  io.error(`codex-bridge: unknown command "${command}"\nRun codex-bridge --help for usage.`);
  return 2;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((err) => {
      console.error(`codex-bridge: ${err.message}`);
      process.exitCode = 2;
    });
}
