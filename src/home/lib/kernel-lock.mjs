/**
 * Locks the kernel releases on its holder's death, shared by the lifecycle lock and the order claim.
 * Plan_60 D4: on 2026-09-24 two launchers with one order id started 2.8 seconds apart and both ran
 * and billed; the runner needs the lifecycle lock's primitive and may not import `cli/`.
 * Where the kernel can release a lock on the holder's death, the lock is a kernel object: a named
 * pipe on Windows, an abstract socket on Linux — both reproduced on real machines (hard kill, name
 * free at once, nothing on disk), which matters on a machine that lost power six times in two weeks.
 * The name comes from the directory's dev+ino, not its path: aliases must reach the same claim.
 * A second listen inside the holder must fail, or the platform did not give exclusivity and the
 * call refuses rather than switch protocols (Plan_65 D5/D8). What the holder answers a waiter is
 * diagnosis only — it never grants anything.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function kernelLockStrategy(platform = process.platform) {
  if (platform === 'win32') return 'named-pipe';
  return platform === 'linux' ? 'abstract-socket' : null;
}

export function kernelLockAddress(purpose, digest, platform = process.platform) {
  if (typeof purpose !== 'string' || !/^[a-z][a-z-]*$/.test(purpose)) {
    throw new TypeError('purpose must match ^[a-z][a-z-]*$');
  }
  if (platform === 'win32') return `\\\\.\\pipe\\codex-bridge-${purpose}-${digest}`;
  return platform === 'linux' ? `\0codex-bridge-${purpose}-${digest}` : null;
}

export function directoryDigest(directory, { suffix } = {}) {
  try {
    const stat = fs.statSync(directory, { bigint: true });
    if (!stat.isDirectory()) throw new Error(`${directory} is not a directory`);
    const identity = `${stat.dev}:${stat.ino}`;
    const extra = typeof suffix === 'string' && suffix.length > 0 ? `:${suffix}` : '';
    return createHash('sha256').update(identity + extra).digest('hex');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function listen(server, address) {
  return new Promise((resolve, reject) => {
    const listening = () => { server.removeListener('error', failed); resolve(); };
    const failed = (error) => { server.removeListener('listening', listening); reject(error); };
    server.once('listening', listening);
    server.once('error', failed);
    try {
      server.listen(address);
    } catch (error) {
      server.removeListener('listening', listening);
      server.removeListener('error', failed);
      reject(error);
    }
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    } catch (error) {
      if (error.code === 'ERR_SERVER_NOT_RUNNING') resolve();
      else reject(error);
    }
  });
}

async function closeQuietly(server) {
  try { await closeServer(server); } catch { /* Preserve the original failure. */ }
}

async function selfCheck(server, address, createServer, label) {
  let probe;
  let detail;
  try {
    probe = createServer();
    await listen(probe, address);
    detail = 'a second listener succeeded';
  } catch (error) {
    if (!error || error.code !== 'EADDRINUSE') detail = (error && (error.code || error.message)) || String(error);
  }
  if (detail === undefined) {
    await closeQuietly(probe);
    return;
  }
  await Promise.all([closeQuietly(probe), closeQuietly(server)]);
  throw new Error(`${label} self-check failed: ${detail}`);
}

export async function tryHoldSocket(address, createServer = net.createServer, label = 'kernel lock') {
  const server = createServer((socket) => socket.destroy());
  try {
    await listen(server, address);
    await selfCheck(server, address, createServer, label);
    let releasePromise;
    return () => (releasePromise ??= closeServer(server));
  } catch (error) {
    await closeQuietly(server);
    if (error?.code === 'EADDRINUSE') return 'in-use';
    throw error;
  }
}

function readSocketHolder(address, timeoutMs, parseAnswer) {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    const socket = net.createConnection(address);
    const timer = setTimeout(() => finish(null), timeoutMs);
    const finish = (holder) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(holder);
    };
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      const newline = data.indexOf('\n');
      if (newline !== -1) finish(parseAnswer(data.slice(0, newline)));
    });
    socket.once('end', () => finish(parseAnswer(data)));
    socket.once('error', () => finish(null));
  });
}

export async function acquireKernelLock({
  address, holder, waitMs, retryMs, answerTimeoutMs, parseAnswer, label,
  createServer = net.createServer,
}) {
  const accepted = new Set();
  const onConnection = (socket) => {
    accepted.add(socket);
    socket.once('close', () => accepted.delete(socket));
    socket.end(`${JSON.stringify(holder)}\n`);
  };
  const deadline = Date.now() + waitMs;

  for (;;) {
    const server = createServer(onConnection);
    try {
      await listen(server, address);
      holder.acquiredAt = new Date().toISOString();
      await selfCheck(server, address, createServer, label);
      server.unref();
      let releasePromise;
      const release = async () => {
        const closing = closeServer(server);
        for (const socket of accepted) socket.destroy();
        await closing;
      };
      return { held: true, release: () => (releasePromise ??= release()) };
    } catch (error) {
      await closeQuietly(server);
      if (!error || error.code !== 'EADDRINUSE') throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await wait(Math.min(retryMs, remaining));
    }
  }

  return { held: false, holder: await readSocketHolder(address, answerTimeoutMs, parseAnswer) };
}
