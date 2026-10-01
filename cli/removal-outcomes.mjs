/**
 * Turns home removal outcomes, or a plan for a dry run, into the lines and exit code the operator sees.
 *
 * Plan_65 D12 item 7 requires actual counts and named keeps: planned removal must not claim
 * that edited image files disappeared, or confuse removing an owner with deleting its record.
 */
import { runsRoot } from '../src/home/lib/runner/runs-root.mjs';

const unsafeReason = (reason) => reason.startsWith('link') || reason.startsWith('unreadable');
// An image file kept by content evidence is named; one kept by policy (another owner, an incomplete
// inventory) is not — that would print ~90 lines the caller explains in one sentence.
const EVIDENCE_KEEP = new Set(['changed', 'link']);
const namedKeep = (entry) => unsafeReason(entry.reason) || entry.id === null
  || (entry.id === 'install-image' && EVIDENCE_KEEP.has(entry.reason));
const artifactsLine = () => `Run artifacts in ${runsRoot()} are outside uninstall and stay.`;

function fileLines(files, host, dryRun) {
  const lines = [];
  const removing = dryRun ? 'remove' : 'removed';
  const verb = dryRun ? 'Would remove' : 'Removed';
  const removed = files.filter((entry) => entry.result === removing);
  const images = removed.filter((entry) => entry.id === 'install-image').length;
  const data = removed.length - images;
  if (images > 0) lines.push(`${verb} ${images} image file(s) from ${host.brandRoot}.`);
  if (data > 0) lines.push(`${verb} ${data} data file(s) from ${host.brandRoot}.`);
  for (const entry of files) {
    if ((entry.result === 'kept' || entry.result === 'blocked') && namedKeep(entry)) {
      lines.push(`${dryRun ? 'Would leave' : 'Left'} brand/${entry.relative} (${entry.reason})`);
    }
  }
  const retained = files.filter((entry) => entry.result === 'kept' && entry.reason === 'purge-only');
  if (retained.length > 0) {
    const paths = retained.map((entry) => entry.relative).sort().join(', ');
    const location = `in ${host.brandRoot} for --purge: ${paths}`;
    lines.push(`${dryRun ? 'Would keep' : 'Kept'} ${retained.length} operator file(s) ${location}`);
  }
  for (const entry of files) {
    if (entry.result === 'failed') lines.push(`Could not remove brand/${entry.relative}: ${entry.reason}`);
  }
  return lines;
}

function recordLines(record, host) {
  if (record.result === 'removed') return [`Removed the installation record of ${host.brandRoot}.`];
  if (record.result === 'failed') return [`Could not remove brand/${record.relative}: ${record.reason}`];
  if (record.result !== 'kept') return [];
  if (record.reason === 'this host removed from the record') {
    return [`Removed ${host.root} from the installation record of ${host.brandRoot}; the shared image stays.`];
  }
  if (record.reason === 'this host is still attached') {
    return [`Kept ${host.root} in the installation record because its hooks could not be removed.`];
  }
  return [`Kept the installation record of ${host.brandRoot} (${record.reason}).`];
}

export function outcomeLines(outcomes, { host }) {
  const files = outcomes.filter((entry) => entry.kind === 'file');
  const record = outcomes.find((entry) => entry.kind === 'record');
  const lines = fileLines(files, host, false);
  if (record) lines.push(...recordLines(record, host));
  for (const entry of outcomes.filter((candidate) => candidate.kind === 'directory')) {
    if (entry.relative === '' && entry.result === 'removed') {
      lines.push(`Removed ${host.brandRoot}.`);
    } else if (entry.result === 'kept') {
      lines.push(`Left brand/${entry.relative}/ (${entry.reason})`);
    } else if (entry.result === 'failed') {
      lines.push(`Could not remove brand/${entry.relative}/: ${entry.reason}`);
    }
  }
  lines.push(artifactsLine());
  return lines;
}

export function outcomeExitCode(outcomes) {
  return outcomes.some((entry) => entry.result === 'blocked' || entry.result === 'failed'
    || (entry.result === 'kept' && unsafeReason(entry.reason))) ? 1 : 0;
}

export function planExitCode(plan) {
  return plan.blocked || plan.rows.some((row) => (row.action === 'keep' || row.action === 'blocked')
    && unsafeReason(row.reason)) ? 1 : 0;
}

export function planLines(plan, { host, detached = true }) {
  const files = plan.rows.map((row) => ({ ...row, result: row.action === 'keep' ? 'kept' : row.action }));
  const lines = fileLines(files, host, true);
  if (plan.record.dependsOnDetach && detached === false) {
    lines.push(`Would keep ${host.root} in the installation record because its hooks could not be removed.`);
  } else if (plan.record.operation === 'delete') {
    lines.push(`Would remove the installation record of ${host.brandRoot}.`);
  } else if (plan.record.operation === 'remove-current-owner') {
    lines.push(`Would remove ${host.root} from the installation record of ${host.brandRoot}; the shared image stays.`);
  } else if (plan.record.operation === 'retain') {
    lines.push(`Would keep the installation record of ${host.brandRoot} (${plan.record.reason})`);
  }
  lines.push(artifactsLine());
  return lines;
}
