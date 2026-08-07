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
import { commandFor, inspectHook } from './settings-merge.mjs';
import { readRulesRegistry } from './rules-owners.mjs';
import { readRunConfig, retentionNotice } from '../src/run-config.mjs';
import { runsRoot } from '../src/runner/runs-root.mjs';
import { resolveProjectRunsDir } from '../src/runner/project-dir.mjs';

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
    const notice = retentionNotice(readRunConfig(path.join(host.agentsDir, 'run-config.json')));
    return check('retention', notice.enabled ? 'warn' : 'ok', notice.text);
  } catch (err) {
    return check('retention', 'fail', `invalid configuration: ${err.message}`);
  }
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

export function probeCodex() {
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'codex';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'codex --version'] : ['--version'];
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    return { available: false, value: (result.stderr || result.error?.message || 'not found').trim() };
  }
  return { available: true, value: (result.stdout || result.stderr).trim() };
}

async function hookChecks(host, record) {
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
    const expected = path.resolve(host.root, recorded.path);
    try {
      const state = await inspectHook(host.settingsPath, {
        event: definition.event,
        matcher: definition.matcher,
        command: commandFor(expected),
      });
      if (state.present) {
        return check(key, 'ok', `${definition.event} matcher ${definition.matcher} -> ${expected}`);
      }
      return check(key, 'warn', `${definition.event} matcher ${definition.matcher} does not point to the installed ${definition.file}`);
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

export async function diagnose({ host, codexProbe = probeCodex, currentPackage } = {}) {
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
  checks.push(...await hookChecks(host, record));
  const retention = retentionCheck(host);
  checks.push(retention);

  const codex = codexProbe();
  checks.push(check('codex', codex.available ? 'ok' : 'warn', codex.value || 'available'));
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  checks.push(check('node', nodeMajor >= 24 ? 'ok' : 'fail', `${process.versions.node} (requires >=24)`));
  checks.push(check('runsRoot', 'ok', path.resolve(runsRoot())));
  const projectRuns = projectRunsCheck();
  checks.push(projectRuns);

  return {
    exitCode: !record || recordBroken || missingFiles.length || rules.status === 'fail'
      || retention.status === 'fail' || projectRuns.status === 'fail' ? 1 : 0,
    checks,
    record,
    missingFiles,
  };
}

export function renderDoctor(result) {
  return result.checks.map(({ key, status, value }) => {
    const rendered = `[${status}] ${key}: ${value}`;
    return key === 'retention' && status === 'warn' ? `${WARNING}${rendered}${RESET}` : rendered;
  }).join('\n');
}
