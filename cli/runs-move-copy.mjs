/**
 * Copies a run store into a caller-created staging folder and proves every byte arrived.
 *
 * Plan_77 D1: the 2026-10-07 VaultForge journal cost $16.57 instead of $0.3-0.8
 * because records lived in another project's git tree. Every record must survive.
 * A 2026-10-08 Windows probe (Plan_77 B5a) preserved trailing dots with ordinary Node
 * absolute paths; keep names verbatim, including tradeforge.loc (do not cd into codex-runs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';

export function sha256File(file) {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, 'r');
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) break;
      digest.update(buffer.subarray(0, bytes));
    }
    return digest.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function entryStat(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`Unsupported run store entry: ${file}`);
  }
  return stat;
}

/** A read-only inventory also serves the dry run; empty folders count as records. */
export function inspectRunStore(root) {
  if (!entryStat(root).isDirectory()) throw new Error(`Run store is not a directory: ${root}`);
  const entries = new Map();
  const totals = { files: 0, directories: 0, bytes: 0 };
  function walk(relative) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const child = path.join(relative, name);
      const stat = entryStat(path.join(root, child));
      const directory = stat.isDirectory();
      entries.set(child, { directory, size: stat.size });
      if (directory) {
        totals.directories += 1;
        walk(child);
      } else {
        totals.files += 1;
        totals.bytes += stat.size;
      }
    }
  }
  walk('');
  return { entries, ...totals };
}

/** Plan_77 D3: reject unsafe destinations before creating any copy. */
export function checkRunStoreDestination({ from, to }) {
  const source = normalizeRepoPath(from);
  const destination = normalizeRepoPath(to);
  if (source === destination || source.startsWith(`${destination}/`) || destination.startsWith(`${source}/`)) {
    throw new Error(`Run store paths overlap: ${from} and ${to}.`);
  }
  let stat;
  try {
    stat = fs.lstatSync(to);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(to).length) {
    throw new Error(`Run store destination is not an empty directory: ${to}.`);
  }
  return true;
}

function verifyPaths(expected, actual, root) {
  for (const relative of [...new Set([...expected.keys(), ...actual.keys()])].sort()) {
    if (!expected.has(relative) || !actual.has(relative)
      || expected.get(relative).directory !== actual.get(relative).directory) {
      throw new Error(`Run store verification failed at ${path.join(root, relative)}: paths differ.`);
    }
  }
}

export function copyRunStore({ from, to, hash = sha256File }) {
  const destinationExists = checkRunStoreDestination({ from, to });
  const original = inspectRunStore(from);
  if (!destinationExists) throw new Error(`Run store staging folder must already exist: ${to}.`);
  try {
    for (const [relative, entry] of original.entries) {
      const src = path.join(from, relative);
      const dst = path.join(to, relative);
      entryStat(src); // Never follow a link introduced between the inventory and the copy.
      if (entry.directory) fs.mkdirSync(dst);
      else fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    }
    const source = inspectRunStore(from);
    const destination = inspectRunStore(to);
    verifyPaths(original.entries, source.entries, from);
    verifyPaths(source.entries, destination.entries, to);
    for (const [relative, entry] of source.entries) {
      if (entry.directory) continue;
      if (entry.size !== destination.entries.get(relative).size
        || hash(path.join(from, relative)) !== hash(path.join(to, relative))) {
        throw new Error(`Run store verification failed at ${relative}: size or hash differs.`);
      }
    }
    // Check the path sets again after hashing, before declaring this copy verified.
    verifyPaths(source.entries, inspectRunStore(from).entries, from);
    verifyPaths(source.entries, inspectRunStore(to).entries, to);
    return { files: source.files, directories: source.directories, bytes: source.bytes };
  } catch (error) {
    // Plan_77 F1: the caller guarantees this staging folder was exclusively created by this process.
    fs.rmSync(to, { recursive: true, force: true });
    throw error;
  }
}
