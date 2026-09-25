/** Judges every observed session host after the 2026-09-25 PATH host identity incident. */
import { contractStatus, PROBE_COMMAND } from './host-contract.mjs';
import { DISPATCHER_CONTRACTS, dispatcherContractStatus } from './dispatcher-contract.mjs';

export function sessionHostVersions(observations) {
  return Object.entries(observations?.hosts ?? {})
    .map(([version, entry]) => ({ version, timestamp: Date.parse(entry?.lastSeen) }))
    .filter(({ timestamp }) => Number.isFinite(timestamp))
    .sort((a, b) => b.timestamp - a.timestamp)
    .map(({ version }) => version);
}

export function sessionHostCheck(versions, observations) {
  if (!versions.length) {
    return {
      key: 'sessionHost',
      status: 'warn',
      value: 'No Claude Code session has been observed by this installation yet; host contracts are judged once a session runs a shell command.',
    };
  }
  const newest = versions[0];
  const lastSeen = new Date(observations.hosts[newest].lastSeen).toISOString();
  const others = versions.slice(1);
  return {
    key: 'sessionHost',
    status: 'ok',
    value: `Sessions run on host ${newest} (last seen ${lastSeen})${others.length ? `; also seen: ${others.join(', ')}` : ''}`,
  };
}

export function otherHostCheck({ version, contractRecord, dispatcherRecord }) {
  const refusal = contractStatus({ record: contractRecord, version });
  const dispatchers = dispatcherContractStatus({ record: dispatcherRecord, version });
  const key = `otherHost:${version}`;
  if (refusal.state === 'ignored' || dispatchers.some(({ state }) => state === 'changed')) {
    const changed = dispatchers.filter(({ state }) => state === 'changed').map(({ contract }) => contract);
    return { key, status: 'fail', value: [refusal.state === 'ignored' ? 'refusal contract ignored' : '', ...changed].filter(Boolean).join('; ') };
  }
  if (refusal.state === 'verified' && dispatchers.every(({ state }) => state === 'verified')) {
    return { key, status: 'ok', value: `Host ${version} refusal and dispatcher contracts are verified.` };
  }
  const missing = [];
  if (refusal.state !== 'verified') missing.push('refusal');
  missing.push(...dispatchers.filter(({ state }) => state !== 'verified').map(({ contract }) => contract));
  const probe = `${PROBE_COMMAND} --probe-executable <path to a ${version} executable>`;
  return {
    key,
    status: 'warn',
    value: `Host ${version} contracts not yet measured: ${missing.join(', ')}; run ${probe}.`,
  };
}
