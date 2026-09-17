/** Reply rows about facts the launcher recorded in status.json before the run began. */
import path from 'node:path';
import { line, readJson } from './paths.mjs';

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

function retentionReply(runDir) {
  const retention = readJson(path.join(runDir, 'status.json'))?.retention;
  const bytes = Number(retention?.bytes_freed);
  const runs = Number(retention?.runs);
  const days = Number(retention?.days);
  if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(runs) || runs <= 0
    || !Number.isFinite(days) || days <= 0) return null;
  return `Retention: freed ${formatBytes(bytes)} from ${runs} runs older than ${days} days`;
}

// Five copies of Retention missed writeFailure(), so both reply assemblers share this point.
// The 2026-09-16 dead Codex sandbox incident is why the launcher probes the sandbox at all.
export function launchRows(runDir) {
  const retention = retentionReply(runDir);
  const rows = retention ? [retention] : [];
  const probe = readJson(path.join(runDir, 'status.json'))?.sandbox_probe;
  if (probe?.outcome === 'inconclusive') {
    const reason = line(probe.reason, 160) || 'no reason recorded';
    rows.push(`Sandbox probe: inconclusive — ${reason} The run started without a sandbox check.`);
  }
  return rows;
}

export function withLaunchRows(rows, runDir) {
  const launch = launchRows(runDir);
  if (!launch.length) return rows;
  let at = rows.findIndex((row) => row.includes('Log: '));
  if (at === -1) at = rows.findIndex((row) => row.startsWith('Run: '));
  return at === -1 ? [...rows, ...launch] : [...rows.slice(0, at), ...launch, ...rows.slice(at)];
}
