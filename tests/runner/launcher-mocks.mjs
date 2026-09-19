/**
 * Generates the child_process mocks pasted into launcher child scripts.
 *
 * Plan_57 A3b: the sandbox probe may reach Codex through spawnSync or spawn, while the worker is
 * always spawn(process.execPath, [entry, '--worker', runDir], ...). Three test files used to
 * replace every spawn with a fake worker, so a probe moved onto spawn would have been handed the
 * worker, or — where spawn was left real — the operator's actual Codex CLI. One routed mock
 * serves both APIs, so the tests hold before and after the probe changes shape.
 */
const WORKER_MODES = ['spawn', 'error', 'forbidden'];
const PROBE_MODES = ['marker', 'real', 'forbidden'];

export function launcherProcessMocks({ worker, probe }) {
  if (!WORKER_MODES.includes(worker)) throw new TypeError(`Unknown worker mock: ${worker}`);
  if (!PROBE_MODES.includes(probe)) throw new TypeError(`Unknown probe mock: ${probe}`);

  return `
import { EventEmitter as LauncherMocksEventEmitter } from 'node:events';
import { PassThrough as LauncherMocksPassThrough } from 'node:stream';
const launcherMocksRealSpawn = childProcess.spawn;
const launcherMocksRealSpawnSync = childProcess.spawnSync;
const launcherMocksWorker = ${JSON.stringify(worker)};
const launcherMocksProbe = ${JSON.stringify(probe)};
// A probe is recognised by the word sandbox, not by "anything that is not git": codexUnavailableReason()
// runs codex --version after a skipped probe, and forbidding that failed an honest test (A3b-1).
// On Windows the whole Codex command line is one cmd.exe argument, hence the token search.
const launcherMocksIsProbe = (args = []) => /(?:^|[\\s"])sandbox(?:[\\s"]|$)/.test(args.join(' '));

childProcess.spawnSync = (command, args = [], options) => {
  if (command === 'git' || launcherMocksProbe === 'real') return launcherMocksRealSpawnSync(command, args, options);
  if (!launcherMocksIsProbe(args)) {
    return { status: 0, signal: null, error: null, stderr: '', stdout: launcherMocksProbe === 'marker' ? 'codex-bridge-sandbox-ok' : '' };
  }
  if (launcherMocksProbe === 'forbidden') throw new Error('A skipped probe must not spawn Codex');
  return { status: 0, signal: null, error: null, stderr: '', stdout: 'codex-bridge-sandbox-ok' };
};

childProcess.spawn = (command, args = [], options) => {
  if (args.includes('--worker')) {
    if (launcherMocksWorker === 'forbidden') throw new Error('unexpected worker spawn');
    const worker = new LauncherMocksEventEmitter();
    worker.pid = 999999;
    worker.unref = () => {};
    queueMicrotask(() => {
      if (launcherMocksWorker === 'error') worker.emit('error', new Error('fixture worker spawn failure'));
      else worker.emit('spawn');
    });
    return worker;
  }
  if (launcherMocksProbe === 'real') return launcherMocksRealSpawn(command, args, options);
  if (launcherMocksProbe === 'forbidden' && launcherMocksIsProbe(args)) {
    throw new Error('A skipped probe must not spawn Codex');
  }
  const child = new LauncherMocksEventEmitter();
  child.pid = 999998;
  child.stdin = null;
  child.stdout = new LauncherMocksPassThrough();
  child.stderr = new LauncherMocksPassThrough();
  child.kill = () => true;
  setImmediate(() => {
    child.emit('spawn');
    child.stdout.end(launcherMocksIsProbe(args) ? 'codex-bridge-sandbox-ok\\n' : '');
    child.stderr.end();
    // Node's order: 'close' only after stdio has drained. Emitting it in the same tick as end()
    // would hand a close-driven reader an empty stdout, and the probe would miss its marker.
    setImmediate(() => {
      child.emit('exit', 0, null);
      setImmediate(() => child.emit('close', 0, null));
    });
  });
  return child;
};
`;
}
