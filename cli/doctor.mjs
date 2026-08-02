/** Diagnoses a Claude Code host without modifying it. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readInstallRecord, packageInfo } from './manifest.mjs';
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
  checks.push(await hookCheck(host, record));

  const codex = codexProbe();
  checks.push(check('codex', codex.available ? 'ok' : 'warn', codex.value || 'available'));
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  checks.push(check('node', nodeMajor >= 24 ? 'ok' : 'fail', `${process.versions.node} (requires >=24)`));
  checks.push(check('runsRoot', 'ok', path.resolve(runsRoot())));
  const projectRuns = resolveProjectRunsDir(runsRoot(), process.cwd(), { create: false });
  checks.push(check('projectRuns', 'ok', `${path.resolve(projectRuns.dir)} (${projectRuns.reason})`));

  return {
    exitCode: !record || recordBroken || missingFiles.length ? 1 : 0,
    checks,
    record,
    missingFiles,
  };
}

export function renderDoctor(result) {
  return result.checks.map(({ key, status, value }) => `[${status}] ${key}: ${value}`).join('\n');
}
