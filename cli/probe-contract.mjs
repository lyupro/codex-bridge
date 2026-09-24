/**
 * Measures whether the installed host applies a PreToolUse refusal, not merely whether the hook
 * returns one. The sibling `allow` decision silently stopped working between hosts 2.1.119 and
 * 2.1.231, so a missing marker is trusted only when the hook fired and the host completed cleanly.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectHostVersion, writeHostContract } from './host-contract.mjs';
import { buildRig } from './probe-rig.mjs';
import { DISPATCHER_CONTRACTS, judgeDispatcherContracts } from './dispatcher-contract.mjs';
import { writeDispatcherContract } from './dispatcher-contract-record.mjs';
import { brandStateDir } from '../src/home/lib/brand-home.mjs';
import { parseJsonText } from '../src/home/lib/json-file.mjs';
import { randomUUID } from 'node:crypto';

export const PROBE_MARKER = 'codex-bridge-contract-probe';

const exists = async (target) => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

function lastNonEmptyLine(output) {
  return String(output ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
}

export function judgeProbe({ markerExists, hookFired, hostResult }) {
  if (markerExists) {
    return { result: 'ignored', reason: 'The marker command ran despite the hook refusal.' };
  }
  if (!hostResult) {
    return { result: null, reason: 'The host could not be started.' };
  }
  if (hostResult.error) {
    const timedOut = hostResult.error.code === 'ETIMEDOUT';
    return {
      result: null,
      reason: timedOut ? 'The host timed out before the probe completed.' : 'The host process failed to start.',
    };
  }
  if (hostResult.signal) {
    return { result: null, reason: `The host was terminated by signal ${hostResult.signal}.` };
  }
  if (hostResult.status !== 0) {
    const output = lastNonEmptyLine(hostResult.stderr) || lastNonEmptyLine(hostResult.stdout);
    const detail = output ? `: ${output.slice(0, 200)}` : '';
    return { result: null, reason: `The host exited with status ${String(hostResult.status)}${detail}.` };
  }
  if (!hookFired) {
    return { result: null, reason: 'The probe hook never received the marker command.' };
  }
  return { result: 'honored', reason: 'The hook fired and the refused marker command did not run.' };
}

export async function probeContract({
  host,
  version = detectHostVersion(),
  runHost = spawnSync,
  rigRoot = os.tmpdir(),
  now = new Date(),
}) {
  if (version == null) {
    return {
      state: 'inconclusive',
      result: null,
      version: null,
      message: 'The host version could not be read, so no contract probe was run.',
      recorded: false,
      dispatcher: Object.fromEntries(DISPATCHER_CONTRACTS.map((name) => [name, { result: 'inconclusive', detail: 'Host version is unavailable.' }])),
    };
  }

  await fs.mkdir(rigRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(rigRoot, `${PROBE_MARKER}-`));
  try {
    const token = randomUUID().slice(0, 8);
    const rig = await buildRig(dir, token);
    let hostResult;
    try {
      hostResult = runHost('claude', [
        '--setting-sources', 'project',
        '--allowedTools', 'Bash,Agent',
        '-p', rig.prompt,
      ], {
        cwd: rig.dir,
        encoding: 'utf8',
        shell: false,
        timeout: 120000,
        windowsHide: true,
      });
    } catch (error) {
      hostResult = { error };
    }

    let entries = [];
    let malformed = false;
    try {
      const source = await fs.readFile(rig.dispatcherJournalPath, 'utf8');
      entries = source.split(/\r?\n/).filter(Boolean).map((line) => parseJsonText(rig.dispatcherJournalPath, line));
    } catch (error) {
      if (error.code !== 'ENOENT') malformed = true;
    }
    const verdict = judgeProbe({
      markerExists: await exists(rig.markerPath),
      hookFired: await exists(rig.journalPath),
      hostResult,
    });
    let dispatcher = judgeDispatcherContracts({
      entries: malformed ? null : entries,
      hostHealthy: !malformed && !hostResult?.error && !hostResult?.signal && hostResult?.status === 0,
      okCommand: rig.okCommand, failCommand: rig.failCommand, okOutput: rig.okOutput,
      failOutput: rig.failOutput, agentType: 'probe-agent', promptToken: token,
    });
    if (verdict.result == null) dispatcher = Object.fromEntries(Object.keys(dispatcher).map((name) => [name, { result: 'inconclusive', detail: 'Refusal probe did not complete.' }]));
    if (verdict.result != null && version != null && !malformed && !hostResult?.error && !hostResult?.signal && hostResult?.status === 0) {
      await writeDispatcherContract({ stateDir: brandStateDir(host.brandRoot), version, verdicts: dispatcher, now });
    }
    if (verdict.result == null) {
      return {
        state: 'inconclusive',
        result: null,
        version,
        message: verdict.reason,
        recorded: false,
        dispatcher: Object.fromEntries(Object.entries(dispatcher).map(([name, item]) => [name, { result: 'inconclusive', detail: 'Host did not complete the probe.' }])),
      };
    }

    await writeHostContract(host, { version, result: verdict.result, now });
    return {
      state: 'probed',
      result: verdict.result,
      version,
      message: verdict.reason,
      recorded: true,
      dispatcher,
    };
  } finally {
    // Windows can retain a just-written hook tree briefly; cleanup failure must not erase a valid
    // measurement or prevent the result from being recorded.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
