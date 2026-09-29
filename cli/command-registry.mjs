/**
 * Lists commands and how each is invoked (Plan_71 D1, advice A1: registry-dispatch).
 * model -h refused help and global help omitted its actions (2026-09-29) because
 * dispatch and usage had separate sources. One registry keeps invocation and help together.
 */
import { diagnose, renderDoctor } from './doctor.mjs';
import { probeContract } from './probe-contract.mjs';
import { resolveProbeTarget } from './probe-target.mjs';
import { brandStateDir } from '../src/home/lib/brand-home.mjs';
import { hook } from './hook.mjs';
import { resolveHost } from './hosts.mjs';
import { install } from './install.mjs';
import { model } from './model.mjs';
import { projects } from './projects.mjs';
import { read } from './read.mjs';
import { runCodex } from './run-launcher.mjs';
import { permissions } from './permissions.mjs';
import { prune } from './prune.mjs';
import { stop } from './stop.mjs';
import { unlock } from './unlock.mjs';
import { uninstall } from './uninstall.mjs';
import { update } from './update.mjs';

export function commandOptions(command, argv) {
  const options = {};
  const booleanFlags = command === 'install' || command === 'update' ? new Set(['--dry-run', '--force'])
    : command === 'uninstall' ? new Set(['--dry-run'])
      : command === 'doctor' ? new Set(['--probe-contract']) : new Set();
  const flagNames = new Map([
    ['--dry-run', 'dryRun'],
    ['--force', 'force'],
    ['--probe-contract', 'probeContract'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (booleanFlags.has(arg)) {
      options[flagNames.get(arg)] = true;
      continue;
    }
    if (arg !== '--scope' && arg !== '--host' && !(command === 'doctor' && arg === '--probe-executable')) throw new Error(`unknown ${command} option "${arg}"`);
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
    options[arg === '--scope' ? 'scope' : arg === '--host' ? 'host' : 'probeExecutable'] = value;
    index += 1;
  }
  return options;
}

export const COMMANDS = [
  {
    name: 'install',
    summary: 'Install codex-bridge into the selected Claude Code host',
    usage: ['codex-bridge install [--scope user|project] [--host <path>] [--dry-run] [--force]'],
    section: 'public',
    async handler(argv, io) {
      const options = commandOptions('install', argv);
      const host = resolveHost(options);
      const result = await install({ host, dryRun: options.dryRun, force: options.force });
      io.log(result.output);
      return result.exitCode;
    },
  },
  {
    name: 'update',
    summary: 'Update a recorded codex-bridge installation',
    usage: ['codex-bridge update [--scope user|project] [--host <path>] [--dry-run] [--force]'],
    section: 'public',
    async handler(argv, io) {
      const options = commandOptions('update', argv);
      const host = resolveHost(options);
      const result = await update({ host, dryRun: options.dryRun, force: options.force });
      io.log(result.output);
      return result.exitCode;
    },
  },
  {
    name: 'permissions',
    summary: 'Show, add, or remove optional shell permission rules',
    usage: ['codex-bridge permissions [add|remove] [--scope user|project] [--host <path>]'],
    section: 'public',
    actions: {
      add: {
        summary: 'Add optional shell permission rules',
        usage: ['codex-bridge permissions add [--scope user|project] [--host <path>]'],
      },
      remove: {
        summary: 'Remove optional shell permission rules',
        usage: ['codex-bridge permissions remove [--scope user|project] [--host <path>]'],
      },
    },
    async handler(argv, io) {
      let action;
      let optionArgs = argv;
      if (argv[0] && !argv[0].startsWith('-')) {
        action = argv[0];
        optionArgs = argv.slice(1);
      }
      if (action && !['add', 'remove'].includes(action)) {
        throw new Error(`unknown permissions action "${action}"`);
      }
      const options = commandOptions('permissions', optionArgs);
      const host = resolveHost(options);
      const result = await permissions({ host, action });
      io.log(result.output);
      return result.exitCode;
    },
  },
  {
    name: 'uninstall',
    summary: 'Remove installed files while preserving run artifacts',
    usage: ['codex-bridge uninstall [--scope user|project] [--host <path>] [--dry-run]'],
    section: 'public',
    async handler(argv, io) {
      const options = commandOptions('uninstall', argv);
      const host = resolveHost(options);
      const result = await uninstall({ host, dryRun: options.dryRun });
      io.log(result.output);
      return result.exitCode;
    },
  },
  {
    name: 'doctor',
    summary: 'Diagnose the selected Claude Code host (--probe-contract measures on a live host)',
    usage: ['codex-bridge doctor [--scope user|project] [--host <path>] [--probe-contract] [--probe-executable <path>]'],
    section: 'public',
    async handler(argv, io) {
      const options = commandOptions('doctor', argv);
      if (options.probeExecutable && !options.probeContract) throw new Error('--probe-executable requires --probe-contract');
      const host = resolveHost(options);
      // The probe runs BEFORE the diagnosis so the `hostContract` line below carries the verdict just
      // measured. Printing the diagnosis first and the measurement after would answer one question
      // twice in one output, with the older answer on top (Plan_52 D25).
      let probe = null;
      if (options.probeContract) {
        const target = resolveProbeTarget({ stateDir: brandStateDir(host.brandRoot), executable: options.probeExecutable });
        if (!target.error) io.log(`probe: target ${target.version} at ${target.executable} (${target.source})`);
        probe = await probeContract({ host, target });
        io.log(`probe: ${probe.message}`);
        for (const [name, verdict] of Object.entries(probe.dispatcher ?? {})) {
          io.log(`probe: ${name} ${verdict.result} — ${verdict.detail}`);
        }
      }
      const result = await diagnose({ host });
      io.log(renderDoctor(result));
      // An inconclusive probe wrote nothing and measured nothing; exiting 0 would let a failed
      // measurement pass silently in a script (Plan_52 D26).
      return probe && probe.state === 'inconclusive' ? 2 : result.exitCode;
    },
  },
  {
    name: 'run',
    summary: 'Start or attach to a delegated Codex run',
    usage: ['codex-bridge run <runner options> --task-file <path>'],
    section: 'public',
    async handler(argv, io) {
      return runCodex(argv);
    },
  },
  {
    name: 'model',
    summary: 'Show, set or list the models delegated roles run on',
    usage: ['codex-bridge model'],
    section: 'public',
    actions: {
      list: {
        summary: 'List the live model catalogue',
        usage: ['codex-bridge model list'],
      },
      set: {
        summary: 'Set the model and optional effort for a role',
        usage: [
          'codex-bridge model set <role> <model> [effort]',
          'codex-bridge model set <role> --model <model> [--effort <effort>]',
        ],
      },
      unset: {
        summary: 'Unset the model override for a role',
        usage: ['codex-bridge model unset <role>'],
      },
      speed: {
        summary: 'Preview, pin (confirm) or unpin the accelerated speed tier of a role',
        usage: [
          'codex-bridge model speed <role> <tier>',
          'codex-bridge model speed <role> <tier> confirm',
          'codex-bridge model speed <role> unset',
        ],
      },
    },
    async handler(argv, io) {
      const result = await model(argv);
      io.log(result.output);
      return result.exitCode;
    },
  },
  {
    name: 'projects',
    summary: 'List projects or runs from the run store',
    usage: ['codex-bridge projects [<name>] [--json]'],
    section: 'public',
    async handler(argv, io) {
      const result = projects(argv);
      io.log(result.output);
      return result.exitCode;
    },
  },
  {
    name: 'prune',
    summary: 'Remove archived transport, or purge selected run folders',
    usage: [
      'codex-bridge prune <project> [<run>] [--purge] [--older-than <age>] [-f] [--json]',
      'codex-bridge prune --all-projects [--older-than <age>] [-f] [--json]',
    ],
    section: 'public',
    async handler(argv, io) {
      const result = await prune(argv);
      io.log(result.output);
      return result.exitCode;
    },
  },
  {
    name: 'unlock',
    summary: 'Close running records whose runner is gone',
    usage: ['codex-bridge unlock [<project>|--all]'],
    section: 'public',
    async handler(argv, io) {
      const result = unlock(argv);
      io.log(result.output);
      return result.exitCode;
    },
  },
  {
    name: 'read',
    summary: "Render a run's structured event stream",
    usage: ['codex-bridge read <run>'],
    section: 'public',
    async handler(argv, io) {
      if (argv.length !== 1) {
        io.error('codex-bridge read requires exactly one run folder (full path or bare name).');
        return 2;
      }
      const result = read({ run: argv[0] });
      io.log(result.output);
      return result.exitCode;
    },
  },
  {
    name: 'stop',
    summary: 'Stop a running Codex run and record FAIL',
    usage: ['codex-bridge stop <run>'],
    section: 'public',
    async handler(argv, io) {
      if (argv.length !== 1) {
        io.error('codex-bridge stop requires exactly one run folder (full path or bare name).');
        return 2;
      }
      const result = await stop({ run: argv[0] });
      io.log(result.output);
      return result.exitCode;
    },
  },
  {
    name: 'hook',
    summary: 'Dispatch a registered guard with stdin unchanged',
    usage: ['codex-bridge hook <name>'],
    section: 'machine',
    async handler(argv, io) {
      return hook(argv, io);
    },
  },
  {
    name: 'sweep',
    summary: 'Renamed to codex-bridge unlock',
    usage: [],
    section: 'renamed',
    async handler(argv, io) {
      io.error('codex-bridge sweep was renamed to codex-bridge unlock; use the new command.');
      return 2;
    },
  },
];
