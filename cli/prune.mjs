/** Confirms, executes, and reports the destructive actions in a prune plan. */
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { inspectSegments } from './link-segments.mjs';
import { parsePruneArgs } from './prune-args.mjs';
import { prunePlan } from './prune-plan.mjs';
import { recursiveSize } from './runs-inventory.mjs';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function ageText(olderThan) {
  if (!olderThan) return null;
  return olderThan.kind === 'date' ? olderThan.date : `${olderThan.amount}${olderThan.unit}`;
}

function commandText(args) {
  const scope = args.allProjects
    ? '--all-projects'
    : [args.projectName, args.runName].filter(Boolean).join(' ');
  const flags = [];
  if (args.purge) flags.push('--purge');
  if (args.olderThanExplicit) flags.push('--older-than', ageText(args.olderThan));
  flags.push('-f');
  return ['codex-bridge prune', scope, ...flags].join(' ');
}

function actionPayload(action) {
  return {
    kind: action.kind,
    strategy: action.strategy,
    project: action.project,
    run: action.run,
    targets: action.targets,
    bytes: action.bytes,
  };
}

function basePayload(plan) {
  return {
    scope: plan.scope,
    strategy: plan.strategy,
    project: plan.project,
    run: plan.run,
    olderThan: ageText(plan.olderThan),
    note: plan.note ?? null,
    actions: plan.actions.map(actionPayload),
    bytes: plan.bytes,
  };
}

function planLines(plan, args) {
  const lines = [
    `Prune plan: ${plan.strategy} ${plan.scope}.`,
    plan.olderThan ? `Age filter: older than ${ageText(plan.olderThan)} (folder name date).` : 'Age filter: none.',
  ];
  for (const action of plan.actions) {
    for (const target of action.targets) lines.push(`Would remove ${target}`);
  }
  if (!plan.actions.length) {
    lines.push(plan.note ? `Nothing would be removed: ${plan.note}.` : 'Nothing would be removed.');
  }
  lines.push(`Space to free: ${formatBytes(plan.bytes)}.`);
  lines.push('Nothing was deleted.');
  lines.push(`To execute: ${commandText(args)}`);
  return lines.join('\n');
}

function reportLines(payload, status) {
  const lines = [
    status === 'completed'
      ? 'Prune completed.'
      : status === 'cancelled'
        ? 'Prune cancelled; no files were deleted.'
        : 'Prune failed.',
  ];
  if (payload.removed.length) {
    lines.push('Removed:');
    for (const target of payload.removed) lines.push(`  ${target}`);
  } else {
    lines.push('Removed: nothing.');
  }
  lines.push(`Space freed: ${formatBytes(payload.bytesFreed)}.`);
  if (payload.failed?.length) {
    lines.push('Failed:');
    for (const failure of payload.failed) lines.push(`  ${failure.target}: ${failure.error}`);
  }
  return lines.join('\n');
}

function output(value, json) {
  return json ? JSON.stringify(value, null, 2) : value.error || reportLines(value, value.status);
}

function result(exitCode, text) {
  return { exitCode, output: text };
}

// One spelling only. A guard that answers to several option names is a guard with several ways
// to be switched off by accident.
function tty(options) {
  if (options.isTTY !== undefined) return Boolean(options.isTTY);
  return Boolean((options.stdin || process.stdin).isTTY);
}

async function defaultPrompt(question, options = {}) {
  const input = options.stdin || process.stdin;
  const outputStream = options.promptOutput || process.stderr;
  const interfaceHandle = readline.createInterface({ input, output: outputStream });
  try {
    const answer = await interfaceHandle.question(`${question} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    interfaceHandle.close();
  }
}

function accepted(answer) {
  return answer === true || /^(y|yes)$/i.test(String(answer ?? '').trim());
}

function currentTargetBytes(target, strategy) {
  if (strategy === 'purge') {
    // The inventory's recursive measurement is the same accounting used by projects and keeps
    // the report honest when a purge contains nested files.
    return recursiveSize(target);
  }
  try {
    return fs.lstatSync(target).size;
  } catch {
    return null;
  }
}

async function confirmAll(plan, args, options) {
  const prompt = options.prompt || defaultPrompt;
  for (const action of plan.actions) {
    const question = action.strategy === 'purge'
      ? `Delete folder ${action.path}?`
      : `Delete archived transport from ${action.project}/${action.run}?\n  ${action.targets.join('\n  ')}`;
    let answer;
    try {
      answer = await prompt(question, action, options);
    } catch (err) {
      return { error: `codex-bridge prune: confirmation failed: ${err.message}` };
    }
    if (!accepted(answer)) return { declined: true };
  }
  return { declined: false };
}

function bytesAfterRemoval(values) {
  return values.every((value) => Number.isFinite(value))
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

/**
 * Uses the shared top-down check before deletion: the old leaf-up walk inspected descendants under
 * a link, and its catch treated every lstat error as a clear path.
 */
async function execute(plan, options) {
  const removed = [];
  const sizes = [];
  const failed = [];
  for (const action of plan.actions) {
    for (const target of action.targets) {
      const inspection = inspectSegments(target, plan.root);
      if (inspection.kind === 'outside') {
        failed.push({ target, error: 'target is outside the configured runs root' });
        continue;
      }
      if (inspection.kind === 'link') {
        failed.push({ target, error: `refusing to delete through a link: ${inspection.at}` });
        continue;
      }
      if (inspection.kind === 'error') {
        failed.push({ target, error: `cannot inspect ${inspection.at} (${inspection.code}); nothing deleted` });
        continue;
      }
      // `missing` goes on: rmSync reports the vanished target honestly, as it always did.
      const bytes = currentTargetBytes(target, action.strategy);
      try {
        fs.rmSync(target, { recursive: action.strategy === 'purge', force: false });
        removed.push(target);
        sizes.push(bytes);
      } catch (err) {
        failed.push({ target, error: err.message });
      }
    }
  }
  const payload = {
    ...basePayload(plan),
    status: failed.length ? 'failed' : 'completed',
    removed,
    bytesFreed: bytesAfterRemoval(sizes),
    failed,
  };
  return { payload, exitCode: failed.length ? 1 : 0 };
}

/** Runs prune with force, TTY, and confirmation guards around the shared read-only plan. */
export async function prune(argv = [], options = {}) {
  const args = parsePruneArgs(argv);
  if (args.error) {
    const payload = { status: 'error', error: args.error };
    return result(2, argv.includes('--json') ? output(payload, true) : payload.error);
  }

  const plan = prunePlan(args, options);
  if (plan.error) {
    const payload = { status: 'error', error: plan.error };
    return result(1, output(payload, args.json));
  }
  if (!args.force) {
    return result(0, args.json
      ? JSON.stringify({ status: 'plan', ...basePayload(plan), command: commandText(args) }, null, 2)
      : planLines(plan, args));
  }
  if (!plan.actions.length) {
    const payload = { status: 'completed', ...basePayload(plan), removed: [], bytesFreed: 0, failed: [] };
    return result(0, output(payload, args.json));
  }
  if (!tty(options)) {
    const message = 'No TTY: refusing deletion because deletion is an operator action; no files were changed.';
    const payload = { status: 'refused', ...basePayload(plan), error: message, removed: [], bytesFreed: 0 };
    return result(1, output(payload, args.json));
  }

  const confirmation = await confirmAll(plan, args, options);
  if (confirmation.error) {
    const payload = { status: 'error', ...basePayload(plan), error: confirmation.error, removed: [], bytesFreed: 0 };
    return result(1, output(payload, args.json));
  }
  if (confirmation.declined) {
    const payload = { status: 'cancelled', ...basePayload(plan), removed: [], bytesFreed: 0 };
    return result(1, output(payload, args.json));
  }

  const executed = await execute(plan, options);
  return result(executed.exitCode, args.json
    ? output(executed.payload, true)
    : reportLines(executed.payload, executed.payload.status));
}

export { defaultPrompt };
