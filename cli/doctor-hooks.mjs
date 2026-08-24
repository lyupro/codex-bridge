/** Reports the health of every hook this package registered in the host. */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOOK_DEFINITIONS } from './manifest.mjs';
import { recordTarget } from './install-record.mjs';
import { commandFor, inspectHook } from './settings-merge.mjs';
import { check } from './doctor-format.mjs';

function hookVersion(command, record, bridgeResult) {
  if (command.startsWith('codex-bridge hook ')) {
    return bridgeResult.available
      ? `global command ${bridgeResult.value}`
      : `global command unavailable (${bridgeResult.value})`;
  }
  return `installed copy ${record.name}@${record.version}`;
}

function probedVersion(result) {
  return result.available ? result.value.match(/(\d+\.\d+\.\d+(?:[-+][^\s]+)?)\s*$/)?.[1] : null;
}

function startHook(target) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [target], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ status: null, stderr: error.message }));
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

function startFailure(definition, result) {
  if (result.status === 0) return null;
  const lines = result.stderr.trim().split(/\r?\n/);
  const resolver = lines.find((line) => /^Error \[ERR_MODULE_NOT_FOUND\]|Cannot find module/.test(line));
  return `${definition.file} did not start: ${resolver || lines.find(Boolean) || `exit code ${result.status}`}`;
}

/**
 * `sourceKind` arrives as an argument rather than being read here, because the function that knows
 * which copy of the package is answering lives beside `diagnose`. Importing it back would make this
 * module and its caller depend on each other, and a cycle between a check and its orchestrator is
 * how one of them ends up half-initialised at import time.
 */
export async function hookChecks(host, record, bridgeProbe, ownPackage, sourceKind) {
  let bridgeResult;
  const bridge = () => {
    bridgeResult ??= bridgeProbe();
    return bridgeResult;
  };
  const starts = record ? await Promise.all(HOOK_DEFINITIONS.map(async (definition) => {
    const recorded = record.hooks.find((hook) => hook.event === definition.event
      && path.basename(hook.path) === definition.file);
    return recorded ? startHook(recordTarget(host, recorded)) : null;
  })) : [];
  return Promise.all(HOOK_DEFINITIONS.map(async (definition, index) => {
    const key = `hook:${definition.event}`;
    if (!record) return check(key, 'warn', 'cannot check before installation');
    // The file, not just the event: PreToolUse carries two hooks of this package, and matching
    // by event alone reported the worktree lock's matcher as pointing at order-gate.mjs. The
    // hook line is the only place an operator can see WHICH file a matcher was registered for,
    // so a wrong name here is worse than no line at all.
    const recorded = record.hooks.find((hook) => hook.event === definition.event
      && path.basename(hook.path) === definition.file);
    if (!recorded) {
      return check(key, 'warn', `${definition.event} hook is not present in the installation record`);
    }
    const expected = recordTarget(host, recorded);
    const fullCommand = commandFor(expected);
    const shortCommand = `codex-bridge hook ${definition.name}`;
    try {
      const state = await inspectHook(host.settingsPath, {
        event: definition.event,
        matcher: definition.matcher,
        command: recorded.command || fullCommand,
        alternateCommands: [fullCommand, shortCommand],
      });
      if (state.present) {
        const recordedMatcher = state.matchedMatcher;
        const command = state.matchedCommand || recorded.command || fullCommand;
        const form = command.startsWith('codex-bridge hook ') ? 'short' : 'path';
        const reason = form === 'short'
          ? 'PATH command uses the globally installed package'
          : 'full path uses the copy placed by the last install';
        const problems = [startFailure(definition, starts[index])].filter(Boolean);
        // The matcher printed is the one the host recorded, never the one this package declares.
        // Until 2026-08-23 the line stated the registry's own value, so a host stuck on the
        // pre-shell matcher read as [ok] while the worktree lock never saw a Bash command — the
        // same shape as the 2026-08-10 defect, where doctor counted files instead of
        // reading them. A check that compares the package to itself cannot fail.
        if (recordedMatcher !== definition.matcher) problems.push(`recorded matcher ${recordedMatcher} differs from expected ${definition.matcher}; run codex-bridge update --force`);
        const commandVersion = form === 'short' ? bridge() : null;
        const globalVersion = probedVersion(commandVersion || { available: false });
        if (globalVersion && globalVersion !== ownPackage.version) {
          problems.push(`global PATH package version ${globalVersion} differs from ${sourceKind} version ${ownPackage.version}`);
        }
        const health = problems.length ? `; ${problems.join('; ')}` : '';
        return check(key, problems.length ? 'warn' : 'ok', `${definition.event} matcher ${recordedMatcher} -> ${expected} (${form} command; ${reason}; ${hookVersion(command, record, commandVersion)}${health})`);
      }
      const command = recorded.command || fullCommand;
      const form = command.startsWith('codex-bridge hook ') ? 'short' : 'path';
      const failure = startFailure(definition, starts[index]);
      const commandVersion = form === 'short' ? bridge() : null;
      return check(key, 'warn', `${definition.event} matcher ${definition.matcher} does not point to the installed ${definition.file} (${form} command; ${hookVersion(command, record, commandVersion)}${failure ? `; ${failure}` : ''})`);
    } catch (err) {
      const value = err.code === 'ENOENT' ? 'settings.json is absent' : `settings.json is invalid: ${err.message}`;
      return check(key, 'warn', `${definition.event} hook: ${value}`);
    }
  }));
}
