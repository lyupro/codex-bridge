/** Records both hardened release-check cells because Plan_64 D13/D14 require fresh isolated proof before each release. */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readJsonFileSync } from '../../src/home/lib/json-file.mjs';
import { resolveBrandHome } from '../../src/home/lib/brand-home.mjs';
import { transcriptHostVersion } from '../../src/home/lib/host-version.mjs';
import { resolveTargets, preflightTarget } from './rules-load-targets.mjs';
import { DEFAULT_ATTEMPT_PATH, judgeCell, exitCodeFor, writeAttempt } from './rules-load-verdict.mjs';
import { createRoleTree, isolatedEnv, installCandidate, freezeInstall, recheckFrozen,
  realStateSentinel, compareSentinel, escapedWitness, removeRoleTree } from './rules-load-isolation.mjs';
import { runSession, awaitWitness } from './rules-load-session.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const USAGE = 'Usage: npm run release-check:rules-load-claude -- --model <id> [--vscode-executable <path>] [--attempt-file <path>]';

function argumentsFor(argv) {
  const names = new Map([['--model', 'model'], ['--vscode-executable', 'vscodeExecutable'], ['--attempt-file', 'attemptFile']]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = names.get(argv[index]);
    const value = argv[index + 1];
    if (!name || Object.hasOwn(result, name) || typeof value !== 'string' || !value.trim() || value.startsWith('--')) return null;
    result[name] = value;
  }
  return result.model ? result : null;
}

function failure(reason) {
  return { outcome: 'failed', reason, invariant: reason };
}

export async function main(argv, deps = {}) {
  const stderr = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const stdout = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const args = argumentsFor(argv);
  if (!args) {
    stderr(USAGE);
    return 2;
  }
  const repositoryRoot = deps.repositoryRoot ?? REPOSITORY_ROOT;
  const originalEnv = { ...(deps.env ?? process.env) };
  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const run = deps.run ?? spawnSync;
  const now = deps.now ?? Date.now;
  const uuid = deps.randomUUID ?? randomUUID;
  const startedAt = new Date(now()).toISOString();
  const attemptId = uuid();
  const attemptFile = path.resolve(repositoryRoot, args.attemptFile ?? DEFAULT_ATTEMPT_PATH);
  const realStateDir = deps.realStateDir
    ?? path.join((deps.resolveBrandHome ?? resolveBrandHome)({ env: originalEnv }).root, 'state');
  // The real load witness is deliberately not hashed: the operator's live sessions append to it during the check,
  // so its bytes prove nothing; an escape is judged by escapedWitness (a session whose cwd is inside the tree).
  async function sentinel() {
    return { ...await (deps.realStateSentinel ?? realStateSentinel)({ env: originalEnv }) };
  }
  let before;
  let sentinelError;
  try { before = await sentinel(); } catch (error) { sentinelError = `cannot prove isolation: ${error.message}`; }
  const targets = await (deps.resolveTargets ?? resolveTargets)({ env: originalEnv, vscodeExecutable: args.vscodeExecutable });
  const cells = {};
  for (const role of ['cli', 'vscode']) {
    const target = targets[role] ?? { role, error: `No ${role} target is available.` };
    const cell = { role, executable: target.executable ?? null, version: null };
    cells[role] = cell;
    let tree;
    try {
      if (sentinelError) {
        Object.assign(cell, { outcome: 'inconclusive', reason: sentinelError });
        continue;
      }
      const preflight = await (deps.preflightTarget ?? preflightTarget)({ target,
        run: deps.preflightRun ?? ((command, flags, options) => run(command, flags, { ...options, env: originalEnv, shell: false, windowsHide: true })),
      });
      cell.version = preflight.version ?? null;
      if (!preflight.ok) {
        Object.assign(cell, { outcome: 'inconclusive', reason: preflight.reason });
        continue;
      }
      tree = await (deps.createRoleTree ?? createRoleTree)({ role, tmpRoot, run });
      const env = await (deps.isolatedEnv ?? isolatedEnv)({ baseEnv: originalEnv, tree });
      const installed = await (deps.installCandidate ?? installCandidate)({ repositoryRoot, tree, env, run });
      if (!installed.ok) {
        Object.assign(cell, failure(installed.reason));
        continue;
      }
      const frozen = await (deps.freezeInstall ?? freezeInstall)({ repositoryRoot, tree });
      if (frozen.invariant) {
        Object.assign(cell, failure(frozen.invariant));
        continue;
      }
      Object.assign(cell, { expectedPath: frozen.expectedPath, sha256: frozen.sha256, snapshot: frozen.snapshot, sessionId: uuid() });
      const session = await (deps.runSession ?? runSession)({ target, tree, env, model: args.model, sessionId: cell.sessionId, spawn: deps.spawn });
      const witness = await (deps.awaitWitness ?? awaitWitness)({ stateDir: path.join(tree.brand, 'state'), sessionId: cell.sessionId,
        expectedPath: frozen.expectedPath, read: deps.readWitness, now: deps.pollNow, sleep: deps.sleep,
      });
      let invariant = await (deps.recheckFrozen ?? recheckFrozen)({ tree, frozen });
      let isolationError;
      try {
        const escaped = await (deps.escapedWitness ?? escapedWitness)({ realStateDir, tree });
        if (escaped.length) invariant = `isolation escape: ${escaped.join(', ')}`;
      } catch (error) {
        isolationError = `cannot prove isolation: ${error.message}`;
      }
      if (!session.ok) invariant ??= session.reason;
      const witnessedSession = witness?.sessions && Object.hasOwn(witness.sessions, cell.sessionId)
        ? witness.sessions[cell.sessionId] : null;
      const transcriptVersion = witnessedSession?.transcriptPath
        ? await (deps.transcriptHostVersion ?? transcriptHostVersion)(witnessedSession.transcriptPath, { sessionId: cell.sessionId }) : null;
      cell.transcriptVersion = transcriptVersion;
      const verdict = (deps.judgeCell ?? judgeCell)({ witness, expectedPath: frozen.expectedPath, frozenSha256: frozen.sha256,
        sessionId: cell.sessionId, transcriptVersion, preflightVersion: preflight.version, invariant });
      Object.assign(cell, verdict);
      if (invariant) cell.invariant = invariant;
      if (isolationError && cell.outcome !== 'failed') Object.assign(cell, { outcome: 'inconclusive', reason: isolationError });
    } catch (error) {
      Object.assign(cell, failure(`Release check could not complete: ${error.message}`));
    } finally {
      if (tree) {
        try {
          const removed = await (deps.removeRoleTree ?? removeRoleTree)({ tree, tmpRoot });
          if (!removed.ok) Object.assign(cell, failure(`Role tree removal failed: ${removed.reason}`));
        } catch (error) {
          Object.assign(cell, failure(`Role tree removal failed: ${error.message}`));
        }
      }
    }
  }
  if (before) {
    try {
      const changed = (deps.compareSentinel ?? compareSentinel)(before, await sentinel());
      for (const cell of Object.values(cells)) {
        if (changed.length && cell.outcome !== 'failed') Object.assign(cell, failure(`real state changed: ${changed.join(', ')}`));
      }
    } catch (error) {
      for (const cell of Object.values(cells)) {
        if (cell.outcome !== 'failed') Object.assign(cell, { outcome: 'inconclusive', reason: `cannot prove isolation: ${error.message}` });
      }
    }
  }
  const revision = await (deps.revisionRun ?? run)('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot, shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000,
  });
  if (!revision || revision.error || revision.signal || revision.status !== 0 || !String(revision.stdout ?? '').trim()) {
    stderr(`Cannot identify candidate revision: ${revision?.error?.message ?? revision?.stderr ?? 'git rev-parse HEAD failed'}`);
    return 1;
  }
  const packageInfo = await (deps.readJsonFile ?? readJsonFileSync)(path.join(repositoryRoot, 'package.json'));
  await (deps.writeAttempt ?? writeAttempt)({ file: attemptFile, attempt: {
    schema: 1, attemptId, startedAt, finishedAt: new Date(now()).toISOString(),
    candidate: { revision: String(revision.stdout).trim(), packageVersion: packageInfo.version }, cells,
  } });
  for (const role of ['cli', 'vscode']) {
    const cell = cells[role];
    stdout(`${role}: ${cell.outcome} — ${cell.version ?? '-'} ${cell.executable ?? '-'} — ${cell.reason}`.replace(/[\r\n]+/g, ' '));
  }
  stdout(`Attempt file: ${attemptFile}`);
  return (deps.exitCodeFor ?? exitCodeFor)(cells);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`Release check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
