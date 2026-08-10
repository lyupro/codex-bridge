/** Diagnoses a Claude Code host without modifying it. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  fileFingerprint,
  HOOK_DEFINITIONS,
  readInstallRecord,
  packageInfo,
} from './manifest.mjs';
import { recordTarget } from './install-record.mjs';
import { inspectPermissions } from './permissions.mjs';
import { commandFor, inspectHook } from './settings-merge.mjs';
import { readRulesRegistry } from './rules-owners.mjs';
import { readRunConfig, retentionNotice } from '../src/run-config.mjs';
import { runsRoot } from '../src/runner/runs-root.mjs';
import { resolveProjectRunsDir } from '../src/runner/project-dir.mjs';
import { allLiveRuns } from '../src/hooks/live-runs.mjs';
import { STOP_COMMAND_TEMPLATE } from '../src/stop-contract.mjs';

const WARNING = '\u001b[33m';
const RESET = '\u001b[0m';

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function isFile(target) {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

function check(key, status, value) {
  return { key, status, value };
}

function retentionCheck(host) {
  try {
    const notice = retentionNotice(readRunConfig(host.brandConfigPath));
    return check('retention', notice.enabled ? 'warn' : 'ok', notice.text);
  } catch (err) {
    return check('retention', 'fail', `invalid configuration: ${err.message}`);
  }
}

async function conventionsCheck(host) {
  const file = host.brandConventionsPath;
  let content;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return check('conventions', 'ok', `${file} (not found; optional)`);
    return check('conventions', 'fail', `cannot read ${file}: ${err.message}`);
  }
  return content.trim()
    ? check('conventions', 'ok', `${file} (found)`)
    : check('conventions', 'warn', `${file} (found but empty)`);
}

/**
 * Which copy of the package is answering. Plan_19 gives the CLI a second name, and a global install
 * puts a second copy of the package on the machine beside any clone. `update` copies host files
 * from whichever copy launched it, so `codexb update` from PATH silently reverts a host that
 * `npm run dev:install` from the clone had just refreshed — and every line below this one describes
 * the host as seen by THIS copy. An operator comparing two diagnoses has no other way to tell them
 * apart.
 */
function sourceCheck() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const installed = root.split(/[\\/]/).includes('node_modules');
  return check('source', 'ok', `${root} (${installed ? 'installed package' : 'clone'})`);
}

/**
 * The runner asks git for the repository root before it picks a runs folder, so doctor has to
 * ask the same question: run from `src/runner`, a plain cwd would name the folder `runner` and
 * report a location no run will ever use.
 */
function repoRoot(cwd) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return top.status === 0 && top.stdout.trim() ? top.stdout.trim() : cwd;
}

/**
 * A marker that cannot be read is exactly what doctor exists to report, so it is caught here.
 * Left to propagate it would kill the whole diagnosis and hide the seven checks around it.
 */
function projectRunsCheck() {
  let resolved;
  try {
    resolved = resolveProjectRunsDir(runsRoot(), repoRoot(process.cwd()), { create: false });
  } catch (err) {
    return check('projectRuns', 'fail', err.message);
  }
  const note = resolved.reason === 'created' ? 'not created yet' : resolved.reason;
  return check('projectRuns', 'ok', `${path.resolve(resolved.dir)} (${note})`);
}

function liveRunsCheck() {
  let count;
  try {
    count = allLiveRuns(runsRoot(), { requireConfirmedIdentity: true }).length;
  } catch (err) {
    return check('liveRuns', 'warn', `working-run count unavailable: ${err.message}`);
  }
  if (!count) return check('liveRuns', 'ok', '0 runs working right now');
  const noun = count === 1 ? 'run' : 'runs';
  return check('liveRuns', 'warn', `${count} ${noun} working right now; stop with ${STOP_COMMAND_TEMPLATE}`);
}

export function probeCodex() {
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'codex';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'codex --version'] : ['--version'];
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    return { available: false, value: (result.stderr || result.error?.message || 'not found').trim() };
  }
  return { available: true, value: (result.stdout || result.stderr).trim() };
}

export function probeCodexBridge() {
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'codex-bridge';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'codex-bridge --version'] : ['--version'];
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    return { available: false, value: (result.stderr || result.error?.message || 'not found').trim() };
  }
  return { available: true, value: (result.stdout || result.stderr).trim() };
}

function hookVersion(command, record, bridgeProbe) {
  if (command.startsWith('codex-bridge hook ')) {
    const result = bridgeProbe();
    return result.available ? `global command ${result.value}` : `global command unavailable (${result.value})`;
  }
  return `installed copy ${record.name}@${record.version}`;
}

async function hookChecks(host, record, bridgeProbe) {
  return Promise.all(HOOK_DEFINITIONS.map(async (definition) => {
    const key = `hook:${definition.event}`;
    if (!record) return check(key, 'warn', 'cannot check before installation');
    // The file, not just the event: PreToolUse carries two hooks of this package, and matching
    // by event alone reported the worktree lock's matcher as pointing at order-gate.mjs. The
    // hook line is the only place an operator can see WHICH file a matcher was registered for,
    // so a wrong name here is worse than no line at all.
    const recorded = record.hooks.find((hook) => hook.event === definition.event
      && path.basename(hook.path) === definition.file);
    if (!recorded) {
      return check(key, 'warn', `${definition.event} hook is not present in the installation record`);
    }
    const expected = recordTarget(host, recorded);
    const fullCommand = commandFor(expected);
    const shortCommand = `codex-bridge hook ${definition.name}`;
    try {
      const state = await inspectHook(host.settingsPath, {
        event: definition.event,
        matcher: definition.matcher,
        command: recorded.command || fullCommand,
        alternateCommands: [fullCommand, shortCommand],
      });
      if (state.present) {
        const command = state.matchedCommand || recorded.command || fullCommand;
        const form = command.startsWith('codex-bridge hook ') ? 'short' : 'path';
        const reason = form === 'short'
          ? 'PATH command uses the globally installed package'
          : 'full path uses the copy placed by the last install';
        return check(key, 'ok', `${definition.event} matcher ${definition.matcher} -> ${expected} (${form} command; ${reason}; ${hookVersion(command, record, bridgeProbe)})`);
      }
      const command = recorded.command || fullCommand;
      const form = command.startsWith('codex-bridge hook ') ? 'short' : 'path';
      return check(key, 'warn', `${definition.event} matcher ${definition.matcher} does not point to the installed ${definition.file} (${form} command; ${hookVersion(command, record, bridgeProbe)})`);
    } catch (err) {
      const value = err.code === 'ENOENT' ? 'settings.json is absent' : `settings.json is invalid: ${err.message}`;
      return check(key, 'warn', `${definition.event} hook: ${value}`);
    }
  }));
}

async function rulesCheck(host, record) {
  if (!record) return check('rules', 'warn', 'cannot check before installation');
  if (!record.rules) {
    return check('rules', 'warn', 'rules were not installed by this installation; install or update will add them');
  }
  let registry;
  try {
    registry = await readRulesRegistry(host);
  } catch (err) {
    // Keep every diagnostic visible: package removal on a broken registry left the host without its watchdog.
    return check('rules', 'fail', err.message);
  }
  const ownerNote = registry?.owners.length > 1 ? `; ${registry.owners.length} owners` : '';
  const fingerprint = await fileFingerprint(record.rules.path);
  if (!fingerprint) return check('rules', 'fail', `${record.rules.path}${ownerNote ? ` (${registry.owners.length} owners)` : ''}`);
  return fingerprint === record.rules.fingerprint
    ? check('rules', 'ok', `${record.rules.path} (matches record${ownerNote})`)
    : check('rules', 'warn', `${record.rules.path} (modified after installation${ownerNote})`);
}

async function permissionsCheck(host) {
  try {
    const status = await inspectPermissions(host.settingsPath);
    // Permission rules are an optional operator action; Plan_22 keeps their absence a warning so
    // doctor does not turn a healthy installation red merely because hardening was not requested.
    // The ask count is part of the line because a full set shadowed by `ask` reads as working and
    // is not: the live run of Plan_22-1 found this line saying `installed (24/24)` over it.
    const shadow = status.askCount ? `, ${status.askCount} shadowed by ask` : '';
    return check('permissions', status.state === 'installed' ? 'ok' : 'warn',
      `${status.state} (${status.present}/${status.total} own strings in allow/deny${shadow})`);
  } catch (err) {
    return check('permissions', 'warn', `cannot inspect permission rules: ${err.message}`);
  }
}

export async function diagnose({ host, codexProbe = probeCodex, bridgeProbe = probeCodexBridge, currentPackage } = {}) {
  const checks = [sourceCheck()];
  const hostExists = await exists(host.root);
  checks.push(check('host', hostExists ? 'ok' : 'warn', `${host.root} (${host.scope}, ${hostExists ? 'exists' : 'absent'})`));

  const ownPackage = currentPackage || await packageInfo();
  let record = null;
  let recordBroken = false;
  try {
    record = await readInstallRecord(host);
    if (!record) checks.push(check('installation', 'fail', 'not installed'));
    else {
      const matches = record.name === ownPackage.name && record.version === ownPackage.version;
      checks.push(check(
        'installation',
        matches ? 'ok' : 'warn',
        `${record.name}@${record.version} (${matches ? 'matches package' : `package is ${ownPackage.name}@${ownPackage.version}`})`,
      ));
    }
  } catch (err) {
    recordBroken = true;
    checks.push(check('installation', 'fail', `broken record: ${err.message}`));
  }

  const missingFiles = [];
  if (record) {
    for (const file of record.files) {
      if (!(await isFile(recordTarget(host, file)))) missingFiles.push(`${file.root}/${file.path}`);
    }
  }
  checks.push(check(
    'files',
    !record ? 'warn' : missingFiles.length ? 'fail' : 'ok',
    !record ? 'not checked' : missingFiles.length ? `missing: ${missingFiles.join(', ')}` : `${record.files.length} installed file(s) present`,
  ));
  const rules = await rulesCheck(host, record);
  checks.push(rules);
  checks.push(await permissionsCheck(host));
  checks.push(...await hookChecks(host, record, bridgeProbe));
  const retention = retentionCheck(host);
  checks.push(retention);
  const conventions = await conventionsCheck(host);
  checks.push(conventions);

  const codex = codexProbe();
  checks.push(check('codex', codex.available ? 'ok' : 'warn', codex.value || 'available'));
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  checks.push(check('node', nodeMajor >= 24 ? 'ok' : 'fail', `${process.versions.node} (requires >=24)`));
  checks.push(check('runsRoot', 'ok', path.resolve(runsRoot())));
  const projectRuns = projectRunsCheck();
  checks.push(liveRunsCheck());
  checks.push(projectRuns);

  return {
    exitCode: !record || recordBroken || missingFiles.length || rules.status === 'fail'
      || retention.status === 'fail' || conventions.status === 'fail' || projectRuns.status === 'fail' ? 1 : 0,
    checks,
    record,
    missingFiles,
  };
}

export function renderDoctor(result) {
  return result.checks.map(({ key, status, value }) => {
    const rendered = `[${status}] ${key}: ${value}`;
    return ['retention', 'conventions', 'permissions', 'liveRuns'].includes(key) && status === 'warn'
      ? `${WARNING}${rendered}${RESET}`
      : rendered;
  }).join('\n');
}
