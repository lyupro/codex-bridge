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

export const PROBE_MARKER = 'codex-bridge-contract-probe';

const MARKER_NAME = `${PROBE_MARKER}.marker`;
const JOURNAL_NAME = 'probe-journal.log';

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

const hookSource = `#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const marker = ${JSON.stringify(PROBE_MARKER)};
const journalPath = fileURLToPath(new URL('../${JOURNAL_NAME}', import.meta.url));
let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

if (typeof input?.tool_input?.command === 'string' && input.tool_input.command.includes(marker)) {
  fs.appendFileSync(journalPath, \`${PROBE_MARKER}\\n\`, 'utf8');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Contract probe refused its marker command.',
    },
  }));
}
`;

// Forward slashes on purpose: the host runs this hook command line through a POSIX shell, and a
// Windows path handed over verbatim arrives carrying backslashes that shell may swallow. The
// doubled form this replacement first carried matched nothing at all on a real path.
const shellQuote = (value) => `"${value.replaceAll('\\', '/').replaceAll('"', '\\"')}"`;

export async function buildRig(dir) {
  const claudeDir = path.join(dir, '.claude');
  const hooksDir = path.join(claudeDir, 'hooks');
  const hookPath = path.join(hooksDir, 'probe-hook.mjs');
  const markerPath = path.join(dir, MARKER_NAME);
  const journalPath = path.join(claudeDir, JOURNAL_NAME);
  const command = `touch ${MARKER_NAME}`;
  const prompt = `Run exactly this Bash command and nothing else: ${command}`;
  const settings = {
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `${shellQuote(process.execPath)} ${shellQuote(hookPath)}` }],
      }],
    },
  };

  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(hookPath, hookSource, 'utf8');
  await fs.writeFile(
    path.join(claudeDir, 'settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf8',
  );
  return { dir, markerPath, journalPath, command, prompt };
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
    };
  }

  await fs.mkdir(rigRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(rigRoot, `${PROBE_MARKER}-`));
  try {
    const rig = await buildRig(dir);
    let hostResult;
    try {
      hostResult = runHost('claude', [
        '--setting-sources', 'project',
        '--allowedTools', 'Bash',
        '-p', rig.prompt,
      ], {
        cwd: rig.dir,
        encoding: 'utf8',
        shell: false,
        timeout: 120000,
      });
    } catch (error) {
      hostResult = { error };
    }

    const verdict = judgeProbe({
      markerExists: await exists(rig.markerPath),
      hookFired: await exists(rig.journalPath),
      hostResult,
    });
    if (verdict.result == null) {
      return {
        state: 'inconclusive',
        result: null,
        version,
        message: verdict.reason,
        recorded: false,
      };
    }

    await writeHostContract(host, { version, result: verdict.result, now });
    return {
      state: 'probed',
      result: verdict.result,
      version,
      message: verdict.reason,
      recorded: true,
    };
  } finally {
    // Windows can retain a just-written hook tree briefly; cleanup failure must not erase a valid
    // measurement or prevent the result from being recorded.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
