import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { DISPATCHER_CONTRACTS } from '../../cli/dispatcher-contract.mjs';
import { dispatcherContractStatus } from '../../cli/dispatcher-contract.mjs';
import { DISPATCHER_CONTRACT_FILE, readDispatcherContract, writeDispatcherContract } from '../../cli/dispatcher-contract-record.mjs';

test('dispatcher record writes and reads an atomic round trip', async () => {
  const root = makeTempTree('dispatcher-contract-record-');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir);
  const now = new Date('2026-09-24T12:00:00.000Z');
  try {
    const verdicts = Object.fromEntries(DISPATCHER_CONTRACTS.map((name) => [name, { result: 'honored', detail: `${name} observed` }]));
    const written = writeDispatcherContract({ stateDir, version: '2.1.281', verdicts, now });
    assert.deepEqual(readDispatcherContract({ stateDir }), written);
    assert.equal(written.hosts['2.1.281'].contracts.agentIdentity.checkedAt, now.toISOString());
    assert.deepEqual(fs.readdirSync(stateDir), [DISPATCHER_CONTRACT_FILE]);
  } finally { await removeTempTree(root); }
});

test('inconclusive verdicts preserve the previous contract entry', async () => {
  const root = makeTempTree('dispatcher-contract-preserve-');
  const stateDir = path.join(root, 'state'); fs.mkdirSync(stateDir);
  try {
    const first = writeDispatcherContract({ stateDir, version: '2.1.281', now: '2026-09-24T12:00:00Z',
      verdicts: { agentIdentity: { result: 'honored', detail: 'present' } } });
    const second = writeDispatcherContract({ stateDir, version: '2.1.282', now: '2026-09-24T13:00:00Z',
      verdicts: { agentIdentity: { result: 'inconclusive', detail: 'no delegation' } } });
    assert.deepEqual(second.hosts['2.1.281'].contracts.agentIdentity, first.hosts['2.1.281'].contracts.agentIdentity);
    assert.deepEqual(second.hosts['2.1.282'].contracts, {});
  } finally { await removeTempTree(root); }
});

test('legacy dispatcher entries regroup by version and writes retain other versions', async () => {
  const root = makeTempTree('dispatcher-contract-legacy-'); const stateDir = path.join(root, 'state'); fs.mkdirSync(stateDir);
  try {
    fs.writeFileSync(path.join(stateDir, DISPATCHER_CONTRACT_FILE), JSON.stringify({ contracts: {
      agentIdentity: { result: 'honored', version: '2.1.281', checkedAt: '2026-09-24T12:00:00Z', detail: 'legacy' },
    } }));
    const legacy = readDispatcherContract({ stateDir });
    assert.deepEqual(legacy.hosts['2.1.281'].contracts.agentIdentity, { result: 'honored', checkedAt: '2026-09-24T12:00:00Z', detail: 'legacy' });
    assert.equal(dispatcherContractStatus({ record: legacy, version: '2.1.281' })[0].state, 'verified');
    assert.equal(dispatcherContractStatus({ record: legacy, version: '2.1.282' })[0].state, 'stale');
    const updated = writeDispatcherContract({ stateDir, version: '2.1.282', verdicts: { agentIdentity: { result: 'inconclusive' } } });
    assert.deepEqual(updated.hosts['2.1.281'], legacy.hosts['2.1.281']);
    assert.equal(updated.hosts['2.1.282'].contracts.agentIdentity, undefined);
  } finally { await removeTempTree(root); }
});

test('corrupt dispatcher record is reported and cannot be overwritten', async () => {
  const root = makeTempTree('dispatcher-contract-corrupt-');
  const stateDir = path.join(root, 'state'); fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, DISPATCHER_CONTRACT_FILE), '{broken', 'utf8');
  try {
    assert.deepEqual(readDispatcherContract({ stateDir }), { corrupt: true });
    assert.throws(() => writeDispatcherContract({ stateDir, version: '2.1.281', verdicts: {} }), /corrupt dispatcher contract/);
  } finally { await removeTempTree(root); }
});
