/** Detects the dead sandbox before an order, after the 2026-09-16, 2026-09-25 and 2026-10-10 refusals. */
import fs from 'node:fs';
import path from 'node:path';
import { check } from './doctor-format.mjs';
import { repositoryRoot } from './hosts.mjs';
import { sandboxModeFor } from '../src/home/lib/runner/codex-args.mjs';
import { probeSandbox } from '../src/home/lib/runner/sandbox-probe.mjs';
import { formatSandboxDiagnosis } from '../src/home/lib/runner/sandbox-diagnosis.mjs';

// Probe reasons are full sentences; joining one to "; probed folder" printed "process.; probed" live.
const clause = (reason) => String(reason).replace(/\.$/, '');

// Plan_78 B2b: healthy probes took 0.6-1.7 s on 2026-10-10; the worst case of two forms,
// three attempts each at 15 s plus the version check stays under the host shell's 120 s default.
export async function sandboxChecks({
  codexAvailable, cwd = process.cwd(), probe = probeSandbox, platform = process.platform,
  timeoutMs = 15_000,
} = {}) {
  const root = repositoryRoot(cwd);
  const folder = `${root} (${fs.existsSync(path.join(root, '.git')) ? 'git repository' : 'current folder'})`;
  const rows = [];
  // Plan_57: concurrent helper setups race on one access-rights state file. Keep both forms sequential.
  for (const agent of ['codex-scout', 'codex-build']) {
    const key = `sandbox:${sandboxModeFor(agent)}`;
    if (codexAvailable === false) {
      rows.push(check(key, 'warn', `not probed: Codex CLI is unavailable; folder: ${folder}`));
      continue;
    }
    const result = await probe({ agent, repo: root, platform, timeoutMs });
    switch (result.outcome) {
      case 'alive':
        rows.push(check(key, 'ok', `${clause(result.reason)}; probed folder: ${folder}`));
        break;
      case 'dead': {
        const diagnosis = result.diagnosis == null
          ? ['No sandbox log diagnosis is available.'] : formatSandboxDiagnosis(result.diagnosis);
        rows.push(check(key, 'fail', [
          result.reason,
          ...diagnosis.map((line) => `    ${line}`),
          '    Repair the host sandbox and rerun codex-bridge doctor.',
          `    Probed folder: ${folder}`,
        ].join('\n')));
        break;
      }
      case 'inconclusive':
        rows.push(check(key, 'warn', `readiness not established: ${clause(result.reason)}; probed folder: ${folder}`));
        break;
      case 'skipped':
        rows.push(check(key, 'warn', `not probed on ${platform}: the package has never observed this platform's sandbox; folder: ${folder}`));
        break;
      default:
        throw new Error(`unknown sandbox probe outcome: ${result.outcome}`);
    }
  }
  return rows;
}
