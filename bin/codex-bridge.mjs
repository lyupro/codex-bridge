#!/usr/bin/env node
/** Dispatches codex-bridge CLI arguments to focused command modules. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose, renderDoctor } from '../cli/doctor.mjs';
import { resolveHost } from '../cli/hosts.mjs';
import { install } from '../cli/install.mjs';
import { read } from '../cli/read.mjs';
import { packageInfo } from '../cli/manifest.mjs';
import { stop } from '../cli/stop.mjs';
import { uninstall } from '../cli/uninstall.mjs';
import { update } from '../cli/update.mjs';

export const HELP = `codex-bridge — Claude Code dispatchers for Codex

Usage:
  codex-bridge install [--scope user|project] [--host <path>] [--dry-run] [--force]
  codex-bridge update [--scope user|project] [--host <path>] [--dry-run] [--force]
  codex-bridge uninstall [--scope user|project] [--host <path>] [--dry-run]
  codex-bridge doctor [--scope user|project] [--host <path>]
  codex-bridge read <run>
  codex-bridge stop <run>
  codex-bridge --help
  codex-bridge --version

Commands:
  install   Install codex-bridge into the selected Claude Code host
  update    Update a recorded codex-bridge installation
  uninstall Remove installed files while preserving run artifacts
  doctor    Diagnose the selected Claude Code host
  read      Render a run's structured event stream
  stop      Stop a running Codex run and record FAIL`;

function commandOptions(command, argv) {
  const options = {};
  const booleanFlags = command === 'install' || command === 'update' ? new Set(['--dry-run', '--force'])
    : command === 'uninstall' ? new Set(['--dry-run']) : new Set();
  const flagNames = new Map([
    ['--dry-run', 'dryRun'],
    ['--force', 'force'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (booleanFlags.has(arg)) {
      options[flagNames.get(arg)] = true;
      continue;
    }
    if (arg !== '--scope' && arg !== '--host') throw new Error(`unknown ${command} option "${arg}"`);
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
    const host = resolveHost(commandOptions(command, rest));
    const result = await diagnose({ host });
    io.log(renderDoctor(result));
    return result.exitCode;
  }
  if (command === 'stop') {
    if (rest.length !== 1) {
      io.error('codex-bridge stop requires exactly one run folder (full path or bare name).');
      return 2;
    }
    const result = await stop({ run: rest[0] });
    io.log(result.output);
    return result.exitCode;
  }
  if (command === 'read') {
    if (rest.length !== 1) {
      io.error('codex-bridge read requires exactly one run folder (full path or bare name).');
      return 2;
    }
    const result = read({ run: rest[0] });
    io.log(result.output);
    return result.exitCode;
  }
  if (command === 'install' || command === 'update' || command === 'uninstall') {
    const options = commandOptions(command, rest);
    const host = resolveHost(options);
    const handlers = {
      install: () => install({ host, dryRun: options.dryRun, force: options.force }),
      update: () => update({ host, dryRun: options.dryRun, force: options.force }),
      uninstall: () => uninstall({ host, dryRun: options.dryRun }),
    };
    const result = await handlers[command]();
    io.log(result.output);
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
