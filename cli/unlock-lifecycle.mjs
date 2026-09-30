/**
 * Parses and renders `unlock --lifecycle [--clear]` (Plan_65 D11): the busy refusal of install, update
 * and uninstall sends the operator here, so the command has to name the holder and clear a crash's lock.
 */
import { resolveBrandHome } from '../src/home/lib/brand-home.mjs';
import { withCommandHelp } from './command-help.mjs';
import { inspectLifecycleLock } from './lifecycle-lock-inspect.mjs';
import { clearLifecycleLock } from './lifecycle-lock-clear.mjs';

const heldLine = (holder) => (
  `held by ${holder.command} for ${holder.hostRoot}, pid ${holder.pid}, since ${holder.acquiredAt}.`
);

function renderClear(observation) {
  const { homeRoot, strategy, holder, lockPath, gatePath, gateLeft } = observation;
  const lines = [`Lifecycle lock of ${homeRoot} (${strategy}), clearing:`];
  let exitCode = 0;
  switch (observation.outcome) {
    case 'cleared':
      lines.push(`Removed the lock left by ${holder.command} for ${holder.hostRoot}, pid ${holder.pid} (dead).`);
      lines.push('The next install, update or uninstall may take it.');
      break;
    case 'free':
      lines.push('Nothing to clear; the lock is free.');
      break;
    case 'kernel-managed':
      lines.push('Kernel-managed lock; nothing to clear.');
      lines.push('Run codex-bridge unlock --lifecycle to see its holder.');
      break;
    case 'refused':
      lines.push(`Refused: ${observation.reason}. Nothing was removed.`);
      if (holder) lines.push(heldLine(holder));
      lines.push(`If you are sure no install, update or uninstall is running, delete ${lockPath} yourself.`);
      exitCode = 1;
      break;
    case 'gate-busy':
      lines.push(`Another clear is in progress or crashed: ${gatePath}.`);
      lines.push('If none is running, delete that file yourself.');
      exitCode = 1;
      break;
    case 'no-home':
      lines.push(`codex-bridge unlock --lifecycle: no package home at ${homeRoot}; nothing to inspect.`);
      exitCode = 1;
      break;
    default:
      throw new Error(`Unknown lifecycle lock clear outcome: ${observation.outcome}`);
  }
  if (gateLeft) {
    lines.push(`Could not remove the clear gate: ${gateLeft}.`);
    lines.push('If no clear is running, delete that file yourself.');
    exitCode = 1;
  }
  return { exitCode, output: lines.join('\n') };
}

export async function unlockLifecycle(argv, options = {}) {
  const clearing = argv.length === 2 && argv[0] === '--lifecycle' && argv[1] === '--clear';
  if (!clearing && (argv.length !== 1 || argv[0] !== '--lifecycle')) {
    // Name the first argument past the longest accepted prefix, not always the second one.
    const accepted = argv[0] === '--lifecycle' ? (argv[1] === '--clear' ? 2 : 1) : 0;
    const argument = argv[accepted];
    return {
      exitCode: 2,
      output: withCommandHelp('unlock', `codex-bridge unlock --lifecycle: unexpected argument "${argument}".`),
    };
  }
  const homeRoot = options.homeRoot ?? resolveBrandHome().root;
  if (clearing) return renderClear(await clearLifecycleLock(homeRoot, options.clear ?? {}));
  const observation = await inspectLifecycleLock(homeRoot, options.inspect ?? {});
  const { strategy, observedAt, holder, liveness } = observation;
  const lines = [`Lifecycle lock of ${homeRoot} (${strategy}), observed ${observedAt}:`];
  let exitCode = 0;
  switch (observation.state) {
    case 'free':
      lines.push('free — no install, update or uninstall holds it.');
      break;
    case 'held':
      if (holder === null) {
        lines.push('held; the holder did not identify itself.');
        break;
      }
      lines.push(heldLine(holder));
      if (strategy === 'file') {
        lines.push(`Holder process: ${liveness}.`);
        if (liveness === 'dead') {
          lines.push('The file was left by a crash. Clear it with codex-bridge unlock --lifecycle --clear');
        }
      }
      break;
    case 'unverified':
      lines.push(`could not be verified: ${observation.reason}. Nothing was changed.`);
      exitCode = 1;
      break;
    case 'no-home':
      lines.push(`codex-bridge unlock --lifecycle: no package home at ${homeRoot}; nothing to inspect.`);
      exitCode = 1;
      break;
    default:
      throw new Error(`Unknown lifecycle lock state: ${observation.state}`);
  }
  return { exitCode, output: lines.join('\n') };
}
