/**
 * Parses and renders lifecycle lock inspection because D11's busy refusal pointed to a command that did not exist.
 */
import { resolveBrandHome } from '../src/home/lib/brand-home.mjs';
import { withCommandHelp } from './command-help.mjs';
import { inspectLifecycleLock } from './lifecycle-lock-inspect.mjs';

export async function unlockLifecycle(argv, options = {}) {
  if (argv.length !== 1 || argv[0] !== '--lifecycle') {
    const argument = argv[0] === '--lifecycle' ? argv[1] : argv[0];
    return {
      exitCode: 2,
      output: withCommandHelp('unlock', `codex-bridge unlock --lifecycle: unexpected argument "${argument}".`),
    };
  }
  const homeRoot = options.homeRoot ?? resolveBrandHome().root;
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
      lines.push(`held by ${holder.command} for ${holder.hostRoot}, pid ${holder.pid}, since ${holder.acquiredAt}.`);
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
