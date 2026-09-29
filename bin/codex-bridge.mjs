#!/usr/bin/env node
/** Dispatches codex-bridge CLI arguments through the command registry (Plan_71 D1). */
import { isInvokedDirectly } from '../cli/invoked-directly.mjs';
import { packageInfo } from '../cli/manifest.mjs';
import { COMMANDS } from '../cli/command-registry.mjs';
import { helpRequest, renderCommandHelp } from '../cli/command-help.mjs';

export { commandOptions } from '../cli/command-registry.mjs';

const publicCommands = COMMANDS.filter((entry) => entry.section === 'public');
const commandWidth = Math.max(...publicCommands.map((entry) => entry.name.length));
export const HELP = [
  'codex-bridge — Claude Code dispatchers for Codex',
  '',
  'Usage:',
  ...publicCommands.flatMap((entry) => [entry, ...Object.values(entry.actions ?? {})]
    .flatMap((section) => section.usage.map((line) => `  ${line}`))),
  '  codexb <same command forms as codex-bridge>',
  '  codex-bridge --help',
  '  codex-bridge --version',
  '',
  'Commands:',
  ...publicCommands.map((entry) => `  ${entry.name.padEnd(commandWidth)}  ${entry.summary}`),
  '',
  'Hook dispatch:',
  ...COMMANDS.filter((entry) => entry.section === 'machine')
    .flatMap((entry) => entry.usage.map((line) => `  ${line}  ${entry.summary}`)),
  '',
  'Run codex-bridge <command> -h for one command.',
].join('\n');

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
  const entry = COMMANDS.find((candidate) => candidate.name === command);
  if (!entry) {
    io.error(`codex-bridge: unknown command "${command}"\nRun codex-bridge --help for usage.`);
    return 2;
  }
  const asked = helpRequest(rest, Object.keys(entry.actions ?? {}));
  if (asked && entry.section !== 'renamed') {
    io.log(renderCommandHelp(entry, asked.action));
    return 0;
  }
  return entry.handler(rest, io);
}

if (isInvokedDirectly(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2))
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((err) => {
      console.error(`codex-bridge: ${err.message}`);
      process.exitCode = 2;
    });
}
