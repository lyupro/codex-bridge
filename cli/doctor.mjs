/** Diagnoses a Claude Code host without modifying it. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readInstallRecord, packageInfo } from './manifest.mjs';
import { recordTarget } from './install-record.mjs';
import { runsRoot } from '../src/home/lib/runner/runs-root.mjs';
import { check, renderDoctor } from './doctor-format.mjs';
import {
  agentsCheck,
  conventionsCheck,
  exists,
  isFile,
  permissionsCheck,
  rulesCheck,
} from './doctor-installation.mjs';
import { hookChecks } from './doctor-hooks.mjs';
import { contractStatus, detectHostVersion, readHostContract } from './host-contract.mjs';
import { liveRunsCheck, projectRunsCheck, retentionCheck } from './doctor-runs.mjs';

export { renderDoctor };

function bridgeCommandCheck(result) {
  return result.available
    ? check('command', 'ok', `codex-bridge resolves on PATH (${result.value})`)
    : check('command', 'warn', `codex-bridge does not resolve on PATH (${result.value}); run npm i -g @lyupro/codex-bridge`);
}

/**
 * Which copy of the package is answering. Plan_19 gives the CLI a second name, and a global install
 * puts a second copy of the package on the machine beside any clone. `update` copies host files
 * from whichever copy launched it, so `codexb update` from PATH silently reverts a host that
 * `npm run dev:install` from the clone had just refreshed — and every line below this one describes
 * the host as seen by THIS copy. An operator comparing two diagnoses has no other way to tell them
 * apart.
 */
function packageSource() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return {
    root,
    kind: root.split(/[\\/]/).includes('node_modules') ? 'installed copy' : 'clone',
  };
}

function sourceCheck() {
  const source = packageSource();
  return check('source', 'ok', `${source.root} (${source.kind === 'installed copy' ? 'installed package' : source.kind})`);
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

export async function diagnose({
  host,
  codexProbe = probeCodex,
  bridgeProbe = probeCodexBridge,
  currentPackage,
  contractRecord,
  hostVersion,
} = {}) {
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
  const agents = await agentsCheck(host, record);
  checks.push(agents);
  const rules = await rulesCheck(host, record);
  checks.push(rules);
  checks.push(await permissionsCheck(host));
  const bridge = bridgeProbe();
  checks.push(bridgeCommandCheck(bridge));
  checks.push(...await hookChecks(host, record, () => bridge, ownPackage, packageSource().kind));
  const hostContract = contractStatus({
    record: contractRecord === undefined ? await readHostContract(host) : contractRecord,
    version: hostVersion === undefined ? detectHostVersion() : hostVersion,
  });
  const hostContractStatus = hostContract.state === 'verified'
    ? 'ok'
    : hostContract.state === 'ignored' ? 'fail' : 'warn';
  checks.push(check('hostContract', hostContractStatus, hostContract.message));
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
    exitCode: !record || recordBroken || missingFiles.length || agents.status === 'fail' || rules.status === 'fail'
      || hostContractStatus === 'fail' || retention.status === 'fail' || conventions.status === 'fail'
      || projectRuns.status === 'fail' ? 1 : 0,
    checks,
    record,
    missingFiles,
  };
}
