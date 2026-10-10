/**
 * Plan_64 D11: the 2026-10-10 live run proved memory_type and entrypoint unreliable;
 * A6 showed a lost hook record cannot prove failure. Judge one host's rules-core load evidence.
 */
import path from 'node:path';
import { buildInstallPlan, contentFingerprint } from './manifest.mjs';
import { plannedContent } from './copy.mjs';
import { check } from './doctor-format.mjs';
import { LOAD_WITNESS_FILE, readLoadWitness } from '../src/home/lib/load-witness.mjs';
import { transcriptHostVersion } from '../src/home/lib/host-version.mjs';

function normalizedPath(target) {
  const resolved = path.resolve(target).replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function loadWitnessChecks({ host, record, stateDir, activeHosts, readVersion = transcriptHostVersion }) {
  if (!record) return [check('claudeRulesLoad', 'warn', 'not checked before installation')];
  const witness = readLoadWitness({ stateDir });
  if (witness.corrupt) {
    return [check('claudeRulesLoad', 'warn', `load witness is unreadable: ${path.join(stateDir, LOAD_WITNESS_FILE)}`)];
  }
  const plan = await buildInstallPlan(host);
  const expected = new Map();
  for (const item of plan.filter((item) => path.dirname(item.target) === host.rulesDir)) {
    expected.set(normalizedPath(item.target), contentFingerprint(await plannedContent(item, host.brandRoot)));
  }
  const byVersion = new Map();
  let pending = 0;
  for (const [sessionId, session] of Object.entries(witness.sessions)) {
    if (!Array.isArray(session?.loads)) continue;
    const loads = session.loads.filter((load) => typeof load?.path === 'string'
      && expected.has(normalizedPath(load.path)));
    if (!loads.length) continue;
    // D11: use the witness session, never a neighboring transcript entry or the current PATH host.
    const version = await readVersion(session.transcriptPath, { sessionId });
    if (version === null) {
      if (loads.some((load) => load.sha256 === expected.get(normalizedPath(load.path)))) pending += 1;
      continue;
    }
    const entries = byVersion.get(version) ?? [];
    for (const load of loads) {
      entries.push({ sessionId, at: load.at, matches: load.sha256 === expected.get(normalizedPath(load.path)),
        hashSkippedReason: load.hashSkippedReason });
    }
    byVersion.set(version, entries);
  }
  const pendingNote = pending ? ` (${pending} session(s) awaiting their transcript)` : '';
  const versions = activeHosts.length ? [...new Set(activeHosts)]
    : [...byVersion].filter(([, entries]) => entries.some((entry) => entry.matches
      || entry.hashSkippedReason === 'core-too-large')).map(([version]) => version);
  if (!versions.length) {
    return [check('claudeRulesLoad', 'warn',
      `no session has witnessed the rules core loading yet; open a new Claude Code session${pendingNote}`)];
  }
  return versions.map((version) => {
    const entries = byVersion.get(version) ?? [];
    const verified = entries.filter((entry) => entry.matches);
    const latest = [...entries].sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    // D15 / review B8: an oversized newest load cannot be proof, even after an older matching load.
    if (latest?.hashSkippedReason === 'core-too-large') {
      return check(`claudeRulesLoad:${version}`, 'warn',
        `rules core hash skipped: core-too-large (host ${version}, latest ${latest.at})${pendingNote}`);
    }
    // D11: a newer load of another package hash invalidates the older positive witness.
    if (latest?.matches && verified.length) {
      const count = new Set(verified.map((entry) => entry.sessionId)).size;
      return check(`claudeRulesLoad:${version}`, 'ok',
        `rules core load witnessed (${count} session(s), latest ${latest.at})${pendingNote}`);
    }
    const stale = latest && !latest.matches ? '; witnessed core differs from this package (stale)' : '';
    return check(`claudeRulesLoad:${version}`, 'warn',
      `no session on host ${version} has witnessed the rules core loading yet${stale}; open a new Claude Code session, then rerun codex-bridge doctor${pendingNote}`);
  });
}
