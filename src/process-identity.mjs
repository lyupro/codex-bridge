/**
 * Answers whether a recorded pid belongs to the process that started this run.
 *
 * Signal 0 is the cheap usual probe. A permission error means only that a process exists, not
 * that it is this run's process, so a stale or missing heartbeat falls through to the OS start
 * time probe. `foreign` is a known-dead diagnostic for callers that need to explain pid reuse;
 * readers treat it like `dead`, while `unverified` remains fail-open.
 */
import { spawnSync } from 'node:child_process';
import { heartbeatAge, HEARTBEAT_STALE_MS } from './heartbeat.mjs';

export const IDENTITY_ALIVE = 'alive';
export const IDENTITY_DEAD = 'dead';
export const IDENTITY_FOREIGN = 'foreign';
export const IDENTITY_UNVERIFIED = 'unverified';
export const PROCESS_START_TOLERANCE_MS = 1_000;
export const LEGACY_START_GRACE_MS = 30_000;

const signalZero = (pid) => process.kill(pid, 0);

function defaultCommandRunner(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function commandStartTime(pid, commandRunner = defaultCommandRunner) {
  try {
    const command = process.platform === 'win32' ? 'powershell.exe' : 'ps';
    const args = process.platform === 'win32'
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // Get-Process answers only for processes of the same user, and the pid this exists to
          // recognise was taken by a SYSTEM service — so CIM has to answer after it. Get-CimInstance
          // returns CreationDate as a DateTime already; the DMTF converter belongs to the older
          // Get-WmiObject and throws "dmtfDate out of range" on this value, which cost this probe
          // its whole purpose once. No $ErrorActionPreference = 'Stop' either: one failing source
          // must fall through to the next rather than end the script.
          [
            `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
            "if ($process) { try { $start = $process.StartTime; if ($start) { $start.ToUniversalTime().ToString('o'); exit 0 } } catch {} }",
            `$cim = Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue`,
            "if ($cim -and $cim.CreationDate) { $cim.CreationDate.ToUniversalTime().ToString('o') }",
          ].join('; '),
        ]
      : ['-o', 'lstart=', '-p', String(pid)];
    const result = commandRunner(command, args);
    if (!result || result.error || result.status !== 0) return null;
    const output = String(result.stdout ?? '').trim();
    return timestamp(output);
  } catch {
    return null;
  }
}

function heartbeatIsFreshForIdentity(runDir, now) {
  if (typeof runDir !== 'string' || !runDir.trim()) return false;
  const age = heartbeatAge(runDir, now);
  // isHeartbeatFresh() deliberately treats a missing file as fresh for pre-Plan_20 records.
  // Identity is stricter: a missing heartbeat proves nothing about THIS process, so it must probe.
  return age !== null && age <= HEARTBEAT_STALE_MS;
}

function optionsFor(input) {
  return input && typeof input === 'object' ? input : {};
}

export function processAlive(pid, kill = signalZero) {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EACCES' || error?.code === 'EPERM';
  }
}

/**
 * Return alive/dead/unverified, with foreign as the explicit known-not-this-run case.
 *
 * The probe and signal-0 runner are injectable so tests can exercise every branch without
 * touching a real process. `commandRunner` receives the same command/arguments pair as spawnSync.
 */
export function processIdentity(input = {}) {
  const options = optionsFor(input);
  const status = options.status && typeof options.status === 'object' ? options.status : options;
  const pid = options.pid ?? status.pid;
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) return IDENTITY_DEAD;

  const kill = options.kill || options.signalZero || signalZero;
  try {
    kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return IDENTITY_DEAD;
    if (error?.code === 'EINVAL') return IDENTITY_DEAD;
    if (error?.code !== 'EACCES' && error?.code !== 'EPERM') return IDENTITY_UNVERIFIED;
  }

  const now = options.now ?? Date.now();
  if (!options.ignoreHeartbeat && heartbeatIsFreshForIdentity(options.runDir, now)) {
    return IDENTITY_ALIVE;
  }

  const probe = options.probe || options.processStartProbe
    || ((value) => commandStartTime(value, options.commandRunner));
  let processStartedAt;
  try {
    processStartedAt = timestamp(probe(pid, options));
  } catch {
    processStartedAt = null;
  }
  if (processStartedAt === null) return IDENTITY_UNVERIFIED;

  const hasRecordedStart = Object.prototype.hasOwnProperty.call(status, 'process_started_at')
    && status.process_started_at !== null
    && status.process_started_at !== '';
  if (hasRecordedStart) {
    const recordedStart = timestamp(status.process_started_at);
    if (recordedStart === null) return IDENTITY_UNVERIFIED;
    return Math.abs(processStartedAt - recordedStart) <= PROCESS_START_TOLERANCE_MS
      ? IDENTITY_ALIVE
      : IDENTITY_FOREIGN;
  }

  const startedAt = timestamp(status.started_at);
  if (startedAt === null) return IDENTITY_UNVERIFIED;
  return processStartedAt > startedAt + LEGACY_START_GRACE_MS
    ? IDENTITY_FOREIGN
    : IDENTITY_ALIVE;
}

export const probeProcessStart = commandStartTime;
