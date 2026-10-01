/**
 * Carries out a home removal plan and records what happened to every entry.
 *
 * Plan_65 D12 item 7 requires the final message to describe outcomes: claiming removal from
 * intentions hid edited files that uninstall actually kept. D4 forbids following links and
 * recursive removal; segment checks run immediately before each planned removal.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
import { directoryArtifact } from '../src/home/lib/home-registry.mjs';
import { inspectSegments } from './link-segments.mjs';
import { installRecordPath, removeInstallOwner } from './install-record.mjs';
import { removeEmptyHome } from './remove-layout.mjs';

function findingReason(finding, root) {
  if (finding.kind === 'link') {
    const relative = path.relative(root, finding.at).split(path.sep).join('/');
    return `link at ${relative}`;
  }
  if (finding.kind === 'error') return `unreadable: ${finding.code}`;
  return finding.kind;
}

const failure = (error) => error.code ?? error.message;

async function executeFiles(host, plan, writer, add) {
  for (const row of plan.rows) {
    if (row.action === 'keep' || row.action === 'blocked' || row.action === 'missing') {
      add(row.relative, row.action === 'keep' ? 'kept' : row.action, row.reason, row.id);
      continue;
    }
    if (row.action !== 'remove') throw new TypeError(`Invalid home file action: ${row.action}`);
    const target = path.join(host.brandRoot, row.relative);
    const finding = inspectSegments(target, host.brandRoot);
    if (finding.kind !== 'clear') {
      add(row.relative, finding.kind === 'missing' ? 'missing' : 'kept',
        findingReason(finding, host.brandRoot), row.id);
      continue;
    }
    try {
      await writer.unlink(row.id, target);
      add(row.relative, 'removed', row.reason, row.id);
    } catch (error) {
      // One failed file does not stop the rest: each is reported, and a repeat run retries it.
      add(row.relative, error.code === 'ENOENT' ? 'missing' : 'failed', failure(error), row.id);
    }
  }
}

// After the files, even when one failed: the record is the inventory a repeat run needs, and
// it changes only for a detached host (cli/uninstall.mjs, D10 item 4).
async function executeRecord(host, record, writer, detached, add) {
  const recordRelative = '.installed.json';
  if (record.dependsOnDetach && !detached) {
    add(recordRelative, 'kept', 'this host is still attached');
    return;
  }
  if (record.operation === 'retain' || record.operation === 'none') {
    add(recordRelative, record.operation === 'retain' ? 'kept' : 'missing', record.reason);
    return;
  }
  if (record.operation !== 'delete' && record.operation !== 'remove-current-owner') {
    throw new TypeError(`Invalid home record operation: ${record.operation}`);
  }
  const target = installRecordPath(host);
  // D4 also guards the owner update, which reads the existing record before publishing it.
  const finding = inspectSegments(target, host.brandRoot);
  if (finding.kind !== 'clear') {
    add(recordRelative, finding.kind === 'missing' ? 'missing' : 'kept', findingReason(finding, host.brandRoot));
    return;
  }
  try {
    if (record.operation === 'delete') {
      await writer.unlink('install-record', target);
      add(recordRelative, 'removed', record.reason);
      return;
    }
    const updated = await removeInstallOwner(host);
    add(recordRelative, updated === null ? 'missing' : 'kept',
      updated === null ? 'missing' : 'this host removed from the record');
  } catch (error) {
    add(recordRelative, error.code === 'ENOENT' ? 'missing' : 'failed', failure(error));
  }
}

async function executeDirectories(host, directories, writer, imageMembers, add) {
  for (const directory of directories) {
    if (directory.action === 'keep') continue;
    if (directory.action !== 'remove-if-empty') {
      throw new TypeError(`Invalid home directory action: ${directory.action}`);
    }
    const target = path.join(host.brandRoot, directory.relative);
    if (directory.relative !== '') {
      const finding = inspectSegments(target, host.brandRoot);
      if (finding.kind === 'missing') continue;
      if (finding.kind !== 'clear') {
        add(directory.relative, 'kept', findingReason(finding, host.brandRoot));
        continue;
      }
    }
    try {
      if ((await fs.readdir(target)).length !== 0) continue;
      if (directory.relative === '') {
        await removeEmptyHome(writer, 'install-image', host.brandRoot);
        // The helper tolerates absence and a newly non-empty root; only absence proves removal.
        try {
          await fs.lstat(target);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          add('', 'removed', directory.reason);
        }
      } else {
        await writer.rmdir(directoryArtifact(directory.relative, { imageMembers }), target);
        add(directory.relative, 'removed', directory.reason);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') add(directory.relative, 'failed', failure(error));
    }
  }
}

export async function executeHomePlan(host, plan, { detached, imageMembers }) {
  if (plan.command === 'purge') {
    throw new Error('purge requires its preflight authorization (Plan_65 D12 item 6)');
  }
  if (plan.command !== 'uninstall') throw new TypeError(`Invalid removal command: ${plan.command}`);

  const writer = createHomeWriter({ root: host.brandRoot, imageMembers });
  const outcomes = [];
  // Each step tags its own outcomes: the renderer must not infer a folder from its position.
  const adder = (kind, fixedId) => (relative, result, reason, id = fixedId) => (
    outcomes.push({ lane: 'home', kind, id, relative, result, reason }));
  await executeFiles(host, plan, writer, adder('file', null));
  await executeRecord(host, plan.record, writer, detached, adder('record', 'install-record'));
  await executeDirectories(host, plan.directories, writer, imageMembers, adder('directory', null));
  return { outcomes };
}
