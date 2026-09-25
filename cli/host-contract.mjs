/**
 * Records whether the installed Claude Code host still honours hook refusals.
 *
 * Every guard here refuses work with `permissionDecision: "deny"`, and the sibling key of that same
 * object died quietly: a neighbouring package established that `"allow"` stopped being honoured
 * somewhere between host 2.1.119 and 2.1.231, with no error printed on the way. Nothing in this
 * package would notice `deny` going the same way — the suite checks that a hook RETURNED a refusal,
 * never that the host APPLIED it. The record is bound to a host version because that is what
 * changes underneath an installation: the host updates itself, the package does not. The
 * 2026-09-25 incident ran VS Code host 2.1.282 beside CLI host 2.1.281, so each version keeps
 * its own verdict and probing either must preserve the other.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CLI_NAMES } from '../src/home/lib/cli-names.mjs';
import { HOOK_DEFINITIONS } from '../src/home/lib/hook-definitions.mjs';
import { readJsonFile } from '../src/home/lib/json-file.mjs';

export const HOST_CONTRACT_RECORD_NAME = '.host-contract.json';

/**
 * The command that runs the probe, kept here so every message gains it in one edit.
 *
 * It stayed unnamed in the messages until the command existed: a package that sends an operator to
 * a command answering `unknown doctor option` has spent its credibility on the first line they
 * read. The advice arrived in the same change as the command, and only in the states a probe can
 * actually change — a message that advises a run which would tell you nothing new is noise.
 *
 * Derived rather than spelled out: Plan_17 §5 found installer and hook lists drifting apart once
 * the same name lived in two places. `CLI_NAMES[0]` is the canonical spelling.
 */
export const PROBE_COMMAND = `${CLI_NAMES[0]} doctor --probe-contract`;

export function hostContractPath(host) {
  if (!host?.brandRoot) throw new Error('host has no brand installation root');
  return path.join(host.brandRoot, HOST_CONTRACT_RECORD_NAME);
}

export async function readHostContract(host) {
  const target = hostContractPath(host);
  try {
    const record = await readJsonFile(target);
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    if (record.hosts && typeof record.hosts === 'object' && !Array.isArray(record.hosts)) return record;
    if (typeof record.version === 'string' && record.version) {
      return { hosts: { [record.version]: { result: record.result, checkedAt: record.checkedAt } } };
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeHostContract(host, { version, result, now = new Date() }) {
  if (typeof version !== 'string' || !version) {
    throw new Error('host contract version must be a non-empty string');
  }
  if (result !== 'honored' && result !== 'ignored') {
    throw new Error('host contract result must be honored or ignored');
  }

  const target = hostContractPath(host);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const previous = await readHostContract(host);
  const cutoff = now.getTime() - 180 * 24 * 60 * 60 * 1000;
  const hosts = Object.fromEntries(Object.entries(previous?.hosts ?? {}).filter(([, entry]) =>
    Number.isFinite(Date.parse(entry?.checkedAt)) && Date.parse(entry.checkedAt) >= cutoff));
  hosts[version] = { result, checkedAt: now.toISOString() };
  const record = { hosts };
  await fs.mkdir(host.brandRoot, { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function parseHostVersion(text) {
  if (typeof text !== 'string') return null;
  return text.trim().match(/^(\d+\.\d+\.\d+)(?:\s|$)/)?.[1] ?? null;
}

export function detectHostVersion({ run = spawnSync } = {}) {
  try {
    const result = run('claude', ['--version'], {
      encoding: 'utf8',
      shell: false,
      timeout: 5000,
      windowsHide: true,
    });
    if (!result || result.error || result.status !== 0) return null;
    return parseHostVersion(result.stdout);
  } catch {
    return null;
  }
}

export function contractStatus({ record, version }) {
  // Loose equality on purpose: a caller that forgot the field hands over `undefined`, and the
  // stale branch below would then report "the current host is undefined" as if it had measured it.
  if (version == null) {
    return {
      state: 'unknown-host',
      message: 'The host version could not be read, so the refusal contract cannot be judged.',
    };
  }
  if (!record) {
    return {
      state: 'unverified',
      message: `The refusal contract has never been probed on this machine (host ${version}); run ${PROBE_COMMAND}.`,
    };
  }
  const entry = record.hosts?.[version];
  if (!entry && Object.keys(record.hosts ?? {}).length) {
    const [otherVersion] = Object.entries(record.hosts).sort((a, b) => Date.parse(b[1]?.checkedAt) - Date.parse(a[1]?.checkedAt))[0];
    return {
      state: 'stale',
      message: `The refusal contract was probed on host ${otherVersion}, but the current host is ${version}; run ${PROBE_COMMAND}.`,
    };
  }
  if (!entry) return { state: 'unverified', message: `The refusal contract has never been probed on this machine (host ${version}); run ${PROBE_COMMAND}.` };
  if (entry.result === 'ignored') {
    const guards = HOOK_DEFINITIONS
      .filter((definition) => definition.event === 'PreToolUse')
      .map((definition) => definition.name)
      .join(', ');
    return {
      state: 'ignored',
      message: `DANGER: Host ${version} does not honour hook refusals, so every guard is inert: ${guards}. Re-run ${PROBE_COMMAND} once the host updates.`,
    };
  }
  if (entry.result === 'honored') {
    return {
      state: 'verified',
      message: `Host ${version} honours hook refusals (verified ${entry.checkedAt}).`,
    };
  }
  return {
    state: 'unverified',
    message: `The refusal contract record is invalid (host ${version}); run ${PROBE_COMMAND}.`,
  };
}
