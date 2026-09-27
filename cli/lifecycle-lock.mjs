/**
 * Serializes install, update and uninstall of one shared package home, which several Claude Code
 * hosts may use at once (Plan_65 D5).
 *
 * The shared file lock deletes a lock older than its window, which would steal from an install
 * paused by sleep or an antivirus scan. Deleting a lock whose holder looks dead is no safer: two
 * waiters both see holder X gone, A deletes X's lock and takes it, B deletes A's on its stale
 * observation, and both write (advice A5). So nothing here ever deletes another holder's lock, and
 * where the kernel can release a lock on the holder's death, the lock is a kernel object: a named
 * pipe on Windows, an abstract socket on Linux — both reproduced on real machines (hard kill, name
 * free at once, nothing on disk), which matters on a machine that lost power six times in two weeks.
 * macOS has no abstract namespace, so it gets an exclusively created file that only its own holder
 * removes, and a crash leaves it for `codex-bridge unlock --lifecycle` (D8).
 *
 * The name comes from the home directory's `dev`+`ino`, not its path: a junction, another letter
 * case or forward slashes reach the same home and must reach the same lock. A second listen inside
 * the holder must fail, or the platform did not give exclusivity and the call refuses rather than
 * switch protocols. What the holder answers a waiter is diagnosis only — it never grants anything.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
import { parseJsonText } from '../src/home/lib/json-file.mjs';

const ARTIFACT_ID = 'install-record';
const LOCK_NAME = '.installed.json.lock';
const TAKEN_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY']);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function validateOptions(homeRoot, { command, hostRoot, waitMs, retryMs, answerTimeoutMs }) {
  if (typeof homeRoot !== 'string' || homeRoot.length === 0) throw new TypeError('homeRoot must be a non-empty path');
  if (typeof command !== 'string' || command.length === 0) throw new TypeError('command must be a non-empty string');
  if (typeof hostRoot !== 'string' || hostRoot.length === 0) throw new TypeError('hostRoot must be a non-empty path');
  for (const [name, value, allowZero] of [
    ['waitMs', waitMs, true], ['retryMs', retryMs, false], ['answerTimeoutMs', answerTimeoutMs, true],
  ]) {
    if (!Number.isFinite(value) || value < (allowZero ? 0 : 1)) {
      throw new TypeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} number`);
    }
  }
}

function statIdentity(homeRoot) {
  try {
    const stat = fs.statSync(homeRoot, { bigint: true });
    if (!stat.isDirectory()) throw new Error(`lifecycle lock home is not a directory: ${homeRoot}`);
    return createHash('sha256').update(`${stat.dev}:${stat.ino}`).digest('hex');
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
    return null;
  }
}

async function prepareHome(homeRoot) {
  const writer = createHomeWriter({ root: homeRoot });
  let digest = statIdentity(homeRoot);
  if (digest === null) {
    try {
      await writer.mkdir(ARTIFACT_ID, homeRoot, { recursive: true });
    } catch (error) {
      throw new Error(`could not create lifecycle lock home through the home adapter: ${error.message}`, { cause: error });
    }
    digest = statIdentity(homeRoot);
    if (digest === null) throw new Error(`home adapter did not create lifecycle lock home: ${homeRoot}`);
  }
  return { writer, digest };
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

async function selfCheck(server, address, createServer) {
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
  throw new Error(`lifecycle lock self-check failed: ${detail}`);
}

function validHolder(value) {
  return value && Number.isInteger(value.pid)
    && typeof value.command === 'string' && value.command.length > 0
    && typeof value.hostRoot === 'string' && value.hostRoot.length > 0
    && typeof value.acquiredAt === 'string' && value.acquiredAt.length > 0
    && typeof value.token === 'string' && value.token.length > 0;
}

function parseHolder(line) {
  try {
    const holder = parseJsonText('<lifecycle lock holder>', line);
    return validHolder(holder) ? holder : null;
  } catch { return null; }
}

function busyMessage(homeRoot, holder, hint = '') {
  const details = validHolder(holder)
    ? `held by ${holder.command} for ${holder.hostRoot}, pid ${holder.pid}, since ${holder.acquiredAt}`
    : 'the holder did not answer (unverified)';
  return new Error(`lifecycle lock busy for ${homeRoot}: ${details}; nothing was changed${hint}`);
}

function readSocketHolder(address, timeoutMs) {
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
      if (newline !== -1) finish(parseHolder(data.slice(0, newline)));
    });
    socket.once('end', () => finish(parseHolder(data)));
    socket.once('error', () => finish(null));
  });
}

function lockResult(token, strategy, releaseAction) {
  let releasePromise;
  return {
    token,
    strategy,
    release() {
      if (!releasePromise) releasePromise = releaseAction();
      return releasePromise;
    },
  };
}

async function acquireSocketLock(homeRoot, holder, {
  address, strategy, waitMs, retryMs, answerTimeoutMs, createServer,
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
      await selfCheck(server, address, createServer);
      server.unref();
      return lockResult(holder.token, strategy, async () => {
        const closing = closeServer(server);
        for (const socket of accepted) socket.destroy();
        await closing;
      });
    } catch (error) {
      await closeQuietly(server);
      if (!error || error.code !== 'EADDRINUSE') throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await wait(Math.min(retryMs, remaining));
    }
  }

  throw busyMessage(homeRoot, await readSocketHolder(address, answerTimeoutMs));
}

async function acquireFileLock(homeRoot, writer, holder, { waitMs, retryMs }) {
  const lockPath = path.join(homeRoot, LOCK_NAME);
  const deadline = Date.now() + waitMs;
  let handle;
  for (;;) {
    try {
      handle = await writer.open(ARTIFACT_ID, lockPath, 'wx');
      break;
    } catch (error) {
      if (!error || !TAKEN_CODES.has(error.code)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        let current = null;
        try { current = parseHolder((await fsp.readFile(lockPath, 'utf8')).split(/\r?\n/, 1)[0]); } catch { /* Diagnosis only. */ }
        throw busyMessage(
          homeRoot,
          current,
          '. If no install, update or uninstall is running, the lock was left by a crash: codex-bridge unlock --lifecycle',
        );
      }
      await wait(Math.min(retryMs, remaining));
    }
  }

  holder.acquiredAt = new Date().toISOString();
  try {
    await handle.writeFile(`${JSON.stringify(holder)}\n`);
  } catch (error) {
    await handle.close().catch(() => {});
    await writer.unlink(ARTIFACT_ID, lockPath).catch(() => {});
    throw error;
  }
  return lockResult(holder.token, 'file', async () => {
    let closeError;
    try { await handle.close(); } catch (error) { closeError = error; }
    try {
      await writer.unlink(ARTIFACT_ID, lockPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    if (closeError) throw closeError;
  });
}

export async function acquireLifecycleLock(homeRoot, {
  command,
  hostRoot,
  waitMs = 15_000,
  retryMs = 100,
  platform = process.platform,
  answerTimeoutMs = 1_000,
  createServer = net.createServer,
} = {}) {
  validateOptions(homeRoot, { command, hostRoot, waitMs, retryMs, answerTimeoutMs });
  const { writer, digest } = await prepareHome(homeRoot);
  const holder = {
    pid: process.pid,
    command,
    hostRoot,
    token: randomUUID(),
  };

  if (platform === 'win32' || platform === 'linux') {
    const address = platform === 'win32'
      ? `\\\\.\\pipe\\codex-bridge-lifecycle-${digest}`
      : `\0codex-bridge-lifecycle-${digest}`;
    return acquireSocketLock(homeRoot, holder, {
      address,
      strategy: platform === 'win32' ? 'named-pipe' : 'abstract-socket',
      waitMs,
      retryMs,
      answerTimeoutMs,
      createServer,
    });
  }
  return acquireFileLock(homeRoot, writer, holder, { waitMs, retryMs });
}
