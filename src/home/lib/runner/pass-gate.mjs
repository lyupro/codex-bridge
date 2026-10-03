/**
 * Decides, before anything is registered, whether a call attaches to an existing run of its order,
 * is a granted continuation, or is a refused repeat.
 *
 * Moved out of launcher.mjs unchanged (Plan_75 P0): the launcher sat at the 400-line gate, and the
 * 2026-10-03 TradeForge advise that died on model capacity showed this gate needs a retry path.
 * It is handed no run directory, so like preflight.mjs it cannot leave a folder behind a refusal.
 */
import path from 'node:path';
import { chainRuns, startedRuns, taskFingerprint, readJson } from '../write-meta.mjs';
import { die } from './args.mjs';
import { EXIT } from './exit-codes.mjs';
import { attach } from './attach.mjs';
import { parseGrant } from '../required-inputs.mjs';
import { continuationRefusal, retryRefusal, readyGrantLines } from './continuation.mjs';
import { advisorTaskOrRefuse } from './advise-carry.mjs';
import { scopeRunRefusal } from './preflight.mjs';

export async function passGate({ opts, taskText, projectRunsRoot, repoRoot }) {
  // A second pass at the same task is a real need — after a timeout or a LIMIT the work has
  // to be finished — so it is allowed and made visible rather than forbidden. What is
  // forbidden is repeating by accident: the orchestrator saw the previous reply, the runner
  // did not, so only the orchestrator can decide there is something left to finish.
  //
  // The task is identified by its text as well as by its slug, because the slug is chosen by
  // whoever repeats the run: on 2026-08-02 a dispatcher whose launcher was killed restarted
  // the identical order as `<slug>-v2` and spent 46k on it. Refused before the folder exists,
  // like --scope.
  const taskHash = taskFingerprint(taskText);
  const grant = parseGrant(taskText);
  if (grant?.error) die(`${grant.error}. The run folder was not created; quota was not spent.`);
  // OW-040, 2026-09-30: only a retry repeats failed scope without spending advise's continuation.
  if (opts.agent === 'codex-advisor' && opts.phase === 'scope' && opts.continue && grant?.kind !== 'retry') {
    die('codex-advisor --phase scope refuses --continue: a scope pass is never continued, and continuing one ' +
      "spends the order's single continuation that its advise phase needs. Action: repeat the scope under a new order id " +
      "without --continue and without a continue: grant, then run advise as that order's continuation; a " +
      'scope run that failed is repeated with a `retry:` grant instead. The run folder was not created; quota was not spent.');
  }
  let continuationGrant = grant?.kind === 'continue' ? grant : null;
  const retryOf = grant?.kind === 'retry' ? grant.run : null;
  const chain = chainRuns(projectRunsRoot, repoRoot, opts.slug, taskHash, opts.orderId, grant?.run);
  const startedChain = startedRuns(projectRunsRoot, chain);
  const attachExistingRun = () => attach({
    runsRoot: projectRunsRoot, repo: repoRoot, slug: opts.slug, taskHash, orderId: opts.orderId, chain,
    grantRun: continuationGrant?.run, isContinue: opts.continue, noWait: opts.noWait,
    retryRun: retryOf ?? undefined,
  });
  let attachedExitCode = opts.continue ? await attachExistingRun() : null;
  if (attachedExitCode !== null) return { exitCode: attachedExitCode };

  // The 2026-08-10_220535_plan25-2-install-table-two-roots incident exposed this ordering:
  // a grant without its flag must refuse before attach can print an older run's verdict.
  // markAbandoned() ran before this gate, so a dead runner already has meta.json with FAIL.
  // A run without a verdict can therefore only still be in flight; ordinary repeats go through
  // attach() after this gate. Repeated --continue calls attach first because their grant is spent.
  if (grant?.kind === 'retry') {
    const retryError = retryRefusal(projectRunsRoot, startedChain, opts.continue, opts.orderId, grant);
    if (retryError) die(retryError);
    const namedStatus = readJson(path.join(projectRunsRoot, grant.run, 'status.json'));
    // A run written before phases existed has none; for every agent but the advisor that is 'default'.
    const phaseOf = (value) => String(value ?? '').trim() || 'default';
    if (namedStatus.agent !== opts.agent || phaseOf(namedStatus.phase) !== phaseOf(opts.phase)) {
      die(`a retry repeats the named run's own agent and phase: ${namedStatus.agent}/${namedStatus.phase}. ` +
        'The run folder was not created; quota was not spent.');
    }
    // Plan_75 D4, TradeForge capacity incident: retry advise against its original successful scope.
    continuationGrant = String(namedStatus.continued_from ?? '').trim()
      ? { run: namedStatus.continued_from, reason: grant.reason } : null;
  } else {
    const continuationError = continuationRefusal(
      projectRunsRoot,
      startedChain,
      opts.continue,
      opts.orderId,
      continuationGrant,
    );
    if (continuationError) die(continuationError);
  }
  // Plan_59 D14: the grant is valid by now; an advise pass may continue only an OK scope run.
  const scopeRun = continuationGrant &&
    scopeRunRefusal({ agent: opts.agent, phase: opts.phase, runsRoot: projectRunsRoot, grantRun: continuationGrant.run });
  if (scopeRun) die(scopeRun, EXIT.FAIL);
  // Plan_59 D22: the advise snapshot is read before the folder exists, so a broken scope result refuses for free.
  const advisorTask = opts.agent === 'codex-advisor' ? advisorTaskOrRefuse({ taskText, phase: opts.phase, runsRoot: projectRunsRoot, grantRun: continuationGrant?.run }) : null;

  // One order produced six Codex runs on 2026-08-03 because the caller's time ceiling made it
  // restart the synchronous launcher. A live same-order run is now the repeat target: attach
  // before creating a folder, probing Codex or spending another token.
  if (!opts.continue) attachedExitCode = await attachExistingRun();
  if (attachedExitCode !== null) return { exitCode: attachedExitCode };

  if (startedChain.length && !opts.continue) {
    const last = startedChain[startedChain.length - 1];
    const lastSlug = String(readJson(path.join(projectRunsRoot, last, 'status.json'))?.slug || '');
    const renamed = lastSlug && lastSlug.toLowerCase() !== String(opts.slug).toLowerCase();
    die(
      `--continue is required: ${
        renamed
          ? `this task already ran in this repository under the name “${lastSlug}”`
          : `runs for task “${opts.slug}” already exist in this repository`
      } (${startedChain.length}), latest: ${path.join(projectRunsRoot, last)}. ` +
        'A repeat run is allowed, but the orchestrator decides, not the runner: it read the ' +
        'previous response and knows whether work remains. Add --continue if you are finishing ' +
        'the same task; changing --slug with the same task text does not stop it being a repeat. ' +
        `${readyGrantLines(projectRunsRoot, startedChain)} ` +
        'The run folder was not created; quota was not spent.',
    );
  }

  return { taskHash, chain, startedChain, continuationGrant, advisorTask, retryOf };
}
