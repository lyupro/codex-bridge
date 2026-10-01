/**
 * Decides, from gathered facts, what happens to every file of the package home.
 *
 * Plan_65 D12 uses one plan for uninstall and purge: decisions precede any deletion,
 * so edited images and entries the inspection could not read stay visible to the caller.
 * The record has its own operation because removing one owner can preserve the shared record.
 */
import {
  HOME_ARTIFACTS,
  HOME_DIRECTORIES,
  classifyHomePath,
  homeArtifact,
} from '../src/home/lib/home-registry.mjs';

const byRelative = (left, right) => (
  left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0
);

// The record changes only after the host is detached (cli/uninstall.mjs, hostSide.detached), so
// every operation that changes it carries that dependency and nothing else does.
function recordOutcome(operation, reason, blocked = false) {
  const dependsOnDetach = operation === 'delete' || operation === 'remove-current-owner';
  return { operation, reason, dependsOnDetach, blocked };
}

// The command that asked for the plan. Not "mode": that word already meant six things in this
// package, and a guard (tests/mode-is-not-a-name.test.mjs) keeps it from meaning a seventh.
function assertCommand(command) {
  if (command !== 'uninstall' && command !== 'purge') throw new TypeError(`Invalid removal command: ${command}`);
}

function metadata(relative, imageMembers) {
  const match = classifyHomePath(relative, { imageMembers });
  return match
    ? { ...match, removal: homeArtifact(match.id).removal }
    : { id: null, role: null, removal: null };
}

function fileDecision(file, command, imageEvidence, imagePolicy) {
  if (file.id === 'install-image') {
    if (!imagePolicy.remove) return { action: 'keep', reason: imagePolicy.reason };
    if (file.role !== 'primary') return { action: 'remove', reason: imagePolicy.reason };
    const evidence = imageEvidence.get(file.relative);
    if (!evidence) throw new TypeError(`Missing image evidence for ${file.relative}`);
    if (!['remove', 'keep', 'missing'].includes(evidence.verdict)) {
      throw new TypeError(`Invalid image evidence for ${file.relative}`);
    }
    return {
      action: evidence.verdict,
      reason: evidence.verdict === 'remove' ? `evidence: ${evidence.reason}` : evidence.reason,
    };
  }
  if (file.id === 'install-record') {
    // D12 item 2 reserves the record operation for B16c; D8/D11 keep its lifecycle sides.
    if (file.role === 'primary' || file.role === 'atomic-temporary') return null;
    if (file.role === 'lock') return { action: 'keep', reason: 'lifecycle lock' };
    if (file.role === 'clear-gate') return { action: 'keep', reason: 'clear queue' };
  }
  if (file.removal === 'purge-only') {
    return command === 'purge'
      ? { action: 'remove', reason: 'purge' }
      : { action: 'keep', reason: 'purge-only' };
  }
  if (file.removal === 'protected') return { action: 'keep', reason: 'protected' };
  throw new TypeError(`Unsupported home file classification for ${file.relative}`);
}

function ancestorDecision(relative, inspection) {
  const isAncestor = (entry) => entry.relative === '' || relative.startsWith(`${entry.relative}/`);
  // D12 item 1: a path hidden by an ancestor is uninspected, not absent.
  for (const [entries, reason] of [
    [inspection.links, 'link at'],
    [inspection.errors, 'unreadable ancestor'],
    [inspection.unknown, 'unknown ancestor'],
  ]) {
    const ancestor = entries.find(isAncestor);
    if (ancestor) return { action: 'blocked', reason: `${reason} ${ancestor.relative}` };
  }
  return { action: 'missing', reason: 'missing' };
}

export function planHomeFiles({ command, inspection, imageMembers, imageEvidence, imagePolicy }) {
  assertCommand(command);
  if (inspection.root === 'missing') return { rows: [], blocked: false };
  if (inspection.root === 'error') return { rows: [], blocked: true };
  if (inspection.root !== 'present') throw new TypeError(`Invalid home root state: ${inspection.root}`);

  const rowsByPath = new Map();
  const add = (relative, classification, decision) => {
    if (!rowsByPath.has(relative)) rowsByPath.set(relative, { relative, ...classification, ...decision });
  };
  for (const entry of inspection.links) {
    add(entry.relative, metadata(entry.relative, imageMembers), { action: 'blocked', reason: 'link' });
  }
  for (const entry of inspection.errors) {
    add(entry.relative, metadata(entry.relative, imageMembers), {
      action: 'blocked', reason: `unreadable: ${entry.code}`,
    });
  }
  for (const entry of inspection.unknown) {
    add(entry.relative, { id: null, role: null, removal: null }, {
      action: 'keep', reason: entry.kind === 'directory' ? 'unknown directory' : 'unknown',
    });
  }
  for (const file of inspection.files) {
    if (rowsByPath.has(file.relative)) continue;
    const decision = fileDecision(file, command, imageEvidence, imagePolicy);
    if (decision) add(file.relative, { id: file.id, role: file.role, removal: file.removal }, decision);
  }

  const expected = new Set(imageMembers);
  for (const artifact of HOME_ARTIFACTS) {
    if (artifact.id === 'install-image' || artifact.id === 'install-record') continue;
    if (Array.isArray(artifact.primary)) {
      for (const relative of artifact.primary) expected.add(relative);
    }
  }
  const inspected = new Set([
    ...inspection.files, ...inspection.links, ...inspection.errors,
    ...inspection.unknown, ...inspection.directories,
  ].map((entry) => entry.relative));
  for (const relative of expected) {
    if (!inspected.has(relative)) {
      add(relative, metadata(relative, imageMembers), ancestorDecision(relative, inspection));
    }
  }
  const rows = [...rowsByPath.values()].sort(byRelative);
  return { rows, blocked: rows.some((row) => row.action === 'blocked') };
}

export function planRecordOperation({ command, recordState, format2, ownerKey, imagePolicy }) {
  assertCommand(command);
  if (!['missing', 'corrupt', 'valid'].includes(recordState)) {
    throw new TypeError(`Invalid installation record state: ${recordState}`);
  }
  if (recordState === 'missing') {
    return recordOutcome('none', 'no installation record');
  }
  // D12 item 4: an unreadable record blocks removal rather than becoming an absent record.
  if (recordState === 'corrupt') {
    return recordOutcome('retain', 'unreadable installation record', true);
  }
  if (command === 'purge' || imagePolicy.remove) {
    return recordOutcome('delete', command === 'purge' ? 'purge' : 'last owner');
  }
  if (Object.hasOwn(format2.owners, ownerKey)) {
    return recordOutcome('remove-current-owner', imagePolicy.reason);
  }
  return recordOutcome('retain', 'not an owner of this home');
}

export function planHomeDirectories({ command, inspection, imageMembers, imagePolicy }) {
  if (inspection.root !== 'present') return [];
  const decide = (relative) => {
    if (command === 'purge') return { relative, action: 'remove-if-empty', reason: 'purge' };
    if (!imagePolicy.remove) return { relative, action: 'keep', reason: imagePolicy.reason };
    const imageDirectory = relative === '' || (
      !HOME_DIRECTORIES.includes(relative)
      && imageMembers.some((member) => member.startsWith(`${relative}/`))
    );
    // D12 item 1: even image ancestors can only be removed once they are empty.
    return imageDirectory
      ? { relative, action: 'remove-if-empty', reason: 'image' }
      : { relative, action: 'keep', reason: 'holds purge-only data' };
  };
  return [...inspection.directories.map((entry) => decide(entry.relative)), decide('')];
}

export function planHomeRemoval(facts) {
  const files = planHomeFiles(facts);
  const record = planRecordOperation(facts);
  const directories = planHomeDirectories(facts);
  const rowsByPath = new Map(files.rows.map((row) => [row.relative, row]));
  for (const file of facts.inspection.files) {
    if (file.id !== 'install-record' || file.role !== 'atomic-temporary' || rowsByPath.has(file.relative)) continue;
    rowsByPath.set(file.relative, {
      relative: file.relative, id: file.id, role: file.role, removal: file.removal,
      action: record.operation === 'delete' ? 'remove' : 'keep',
      reason: record.operation === 'delete' ? 'record deleted' : 'record in use',
    });
  }
  const rows = [...rowsByPath.values()].sort(byRelative);
  return { rows, directories, record, blocked: files.blocked || record.blocked };
}
