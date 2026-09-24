/** Diagnoses a Claude Code host without modifying it. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { packageSource } from './package-source.mjs';
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
import { handbackWitnessStatus } from './handback-witness-check.mjs';
import { dispatcherContractStatus } from './dispatcher-contract.mjs';
import { DISPATCHER_CONTRACT_FILE, readDispatcherContract } from './dispatcher-contract-record.mjs';
import { PROBE_COMMAND } from './host-contract.mjs';
import { readHandbackWitness } from '../src/home/lib/handback-witness.mjs';
import { brandStateDir } from '../src/home/lib/brand-home.mjs';
import { liveRunsCheck, projectRunsCheck, retentionCheck } from './doctor-runs.mjs';

export { renderDoctor };

function bridgeCommandCheck(result) {
  return result.available
    ? check('command', 'ok', `codex-bridge resolves on PATH (${result.value})`)
    : check('command', 'warn', `codex-bridge does not resolve on PATH (${result.value}); run npm i -g @lyupro/codex-bridge`);
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

// Plan_62 D19: `changed` fails because the dispatcher gate rests on that contract; everything short of a
// measured break only warns. A corrupt record gets one line: the probe refuses to overwrite it.
const DISPATCHER_CONTRACT_STATUS = { verified: 'ok', changed: 'fail' };

function dispatcherContractChecks({ record, version, stateDir }) {
  if (record?.corrupt) {
    return [check('dispatcherContract', 'warn',
      `The dispatcher contract record is unreadable; delete ${path.join(stateDir, DISPATCHER_CONTRACT_FILE)}, then run ${PROBE_COMMAND}.`)];
  }
  return dispatcherContractStatus({ record, version }).map(({ contract, state, message }) =>
    check(`dispatcherContract:${contract}`, DISPATCHER_CONTRACT_STATUS[state] ?? 'warn', message));
}

export async function diagnose({
  host,
  codexProbe = probeCodex,
  bridgeProbe = probeCodexBridge,
  launcherProbe,
  currentPackage,
  contractRecord,
  handbackWitnessRecord,
  dispatcherContractRecord,
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
  checks.push(...await hookChecks(host, record, launcherProbe));
  const detectedHostVersion = hostVersion === undefined ? detectHostVersion() : hostVersion;
  const hostContract = contractStatus({
    record: contractRecord === undefined ? await readHostContract(host) : contractRecord,
    version: detectedHostVersion,
  });
  const hostContractStatus = hostContract.state === 'verified'
    ? 'ok'
    : hostContract.state === 'ignored' ? 'fail' : 'warn';
  checks.push(check('hostContract', hostContractStatus, hostContract.message));
  const stateDir = brandStateDir(host.brandRoot);
  const witness = handbackWitnessStatus({
    record: handbackWitnessRecord === undefined ? readHandbackWitness({ stateDir }) : handbackWitnessRecord,
    hostVersion: detectedHostVersion,
    stateDir,
  });
  checks.push(check('handbackWitness', ['seen', 'unobserved'].includes(witness.state) ? 'ok' : 'warn', witness.message));
  checks.push(...dispatcherContractChecks({
    record: dispatcherContractRecord === undefined ? readDispatcherContract({ stateDir }) : dispatcherContractRecord,
    version: detectedHostVersion,
    stateDir,
  }));
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
      || projectRuns.status === 'fail'
      || checks.some((item) => /^(hook|dispatcherContract):/.test(item.key) && item.status === 'fail') ? 1 : 0,
    checks,
    record,
    missingFiles,
  };
}
