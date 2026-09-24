import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { DISPATCHER_CONTRACTS } from '../../cli/dispatcher-contract.mjs';
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
    assert.equal(written.contracts.agentIdentity.checkedAt, now.toISOString());
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
    assert.deepEqual(second.contracts.agentIdentity, first.contracts.agentIdentity);
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
