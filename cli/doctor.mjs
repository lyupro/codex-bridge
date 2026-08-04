/** Diagnoses a Claude Code host without modifying it. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileFingerprint, readInstallRecord, packageInfo } from './manifest.mjs';
import { readRulesRegistry } from './rules-owners.mjs';
import { runsRoot } from '../src/runner/runs-root.mjs';
import { resolveProjectRunsDir } from '../src/runner/project-dir.mjs';

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

function hookCommands(value) {
  if (Array.isArray(value)) return value.flatMap(hookCommands);
  if (value && typeof value === 'object') {
    const own = value.type === 'command' && typeof value.command === 'string' ? [value.command] : [];
    return [...own, ...Object.values(value).filter((child) => child !== value.command).flatMap(hookCommands)];
  }
  return [];
}

function commandReferences(command, expected) {
  const normalizedExpected = path.resolve(expected).split(path.sep).join('/');
  const tokens = [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3]);
  return tokens.some((token) => path.resolve(token).split(path.sep).join('/') === normalizedExpected);
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

async function hookCheck(host, record) {
  if (!record) return check('hook', 'warn', 'cannot check before installation');
  let settings;
  try {
    settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  } catch (err) {
    const value = err.code === 'ENOENT' ? 'settings.json is absent' : `settings.json is invalid: ${err.message}`;
    return check('hook', 'warn', value);
  }
  const registration = settings?.hooks?.SubagentStop;
  if (!registration) return check('hook', 'warn', 'SubagentStop is not registered');
  const expected = path.resolve(host.root, record.hook.path);
  const commands = hookCommands(registration);
  const pointsToGuard = commands.some((command) => commandReferences(command, expected));
  return pointsToGuard
    ? check('hook', 'ok', `SubagentStop -> ${expected}`)
    : check('hook', 'warn', 'SubagentStop does not point to the installed reply-guard.mjs');
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

export async function diagnose({ host, codexProbe = probeCodex, currentPackage } = {}) {
  const checks = [];
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
    for (const relative of record.files) {
      if (!(await isFile(path.join(host.root, relative)))) missingFiles.push(relative);
    }
  }
  checks.push(check(
    'files',
    !record ? 'warn' : missingFiles.length ? 'fail' : 'ok',
    !record ? 'not checked' : missingFiles.length ? `missing: ${missingFiles.join(', ')}` : `${record.files.length} installed file(s) present`,
  ));
  const rules = await rulesCheck(host, record);
  checks.push(rules);
  checks.push(await hookCheck(host, record));

  const codex = codexProbe();
  checks.push(check('codex', codex.available ? 'ok' : 'warn', codex.value || 'available'));
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  checks.push(check('node', nodeMajor >= 24 ? 'ok' : 'fail', `${process.versions.node} (requires >=24)`));
  checks.push(check('runsRoot', 'ok', path.resolve(runsRoot())));
  const projectRuns = projectRunsCheck();
  checks.push(projectRuns);

  return {
    exitCode: !record || recordBroken || missingFiles.length || rules.status === 'fail'
      || projectRuns.status === 'fail' ? 1 : 0,
    checks,
    record,
    missingFiles,
  };
}

export function renderDoctor(result) {
  return result.checks.map(({ key, status, value }) => `[${status}] ${key}: ${value}`).join('\n');
}
