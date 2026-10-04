/**
 * Inspects a lifecycle lock without changing its home or lock file for unlock diagnosis (Plan_65 D11).
 * A14: a silent holder cannot prove freedom; only a refused connection followed by an exclusive
 * trial hold can, and a dead file-lock holder still owns the present file until explicit clearing.
 */
import fsp from 'node:fs/promises';
import net from 'node:net';
import { tryHoldSocket } from '../src/home/lib/kernel-lock.mjs';
import {
  holderLiveness, lifecycleLockAddress, lifecycleLockStrategy, parseHolder,
} from './lifecycle-lock.mjs';

const refusedCodes = new Set(['ECONNREFUSED', 'ENOENT']);
const errorReason = (error) => error?.code || error?.message || String(error);

function readSocketAnswer(address, timeoutMs, createConnection) {
  return new Promise((resolve) => {
    let socket;
    let timer;
    let data = '';
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(outcome);
    };
    const failed = (error) => finish({
      kind: refusedCodes.has(error?.code) ? 'refused' : 'error',
      reason: errorReason(error),
    });
    const answered = (line) => {
      const holder = parseHolder(line);
      finish(holder ? { kind: 'answer', holder } : { kind: 'malformed', reason: 'malformed holder answer' });
    };
    try {
      socket = createConnection(address);
      timer = setTimeout(() => finish({ kind: 'timeout', reason: 'holder answer timed out' }), timeoutMs);
      socket.on('data', (chunk) => {
        data += chunk.toString('utf8');
        const newline = data.indexOf('\n');
        if (newline !== -1) answered(data.slice(0, newline));
      });
      socket.once('end', () => answered(data));
      socket.once('error', failed);
      socket.once('close', () => finish({ kind: 'error', reason: 'connection closed without a holder answer' }));
    } catch (error) {
      failed(error);
    }
  });
}

export async function inspectLifecycleLock(homeRoot, {
  platform = process.platform,
  createServer = net.createServer,
  answerTimeoutMs = 1_000,
  identity = {},
  createConnection = net.createConnection,
} = {}) {
  const observation = {
    strategy: lifecycleLockStrategy(platform),
    homeRoot,
    observedAt: new Date().toISOString(),
  };
  const result = (value) => ({ ...observation, ...value });
  try {
    const target = lifecycleLockAddress(homeRoot, { platform });
    if (target === null) return result({ state: 'no-home' });
    if (target.strategy === 'file') {
      let content;
      try {
        content = await fsp.readFile(target.address, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return result({ state: 'free' });
        return result({ state: 'unverified', reason: errorReason(error) });
      }
      const holder = parseHolder(content.split(/\r?\n/, 1)[0]);
      if (!holder) return result({ state: 'unverified', reason: 'malformed holder file' });
      return result({ state: 'held', holder, liveness: holderLiveness(holder, identity) });
    }
    const answer = await readSocketAnswer(target.address, answerTimeoutMs, createConnection);
    if (answer.kind === 'answer') return result({ state: 'held', holder: answer.holder });
    if (answer.kind !== 'refused') return result({ state: 'unverified', reason: answer.reason });
    const release = await tryHoldSocket(target.address, createServer, 'lifecycle lock');
    if (release === 'in-use') return result({ state: 'held', holder: null });
    await release();
    return result({ state: 'free' });
  } catch (error) {
    return result({ state: 'unverified', reason: errorReason(error) });
  }
}
