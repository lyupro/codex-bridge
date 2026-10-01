/**
 * Lists what lies in the package home, classified by the home registry, without crossing a link.
 *
 * Plan_65 D4 trusts the root as written: a relocated home or CODEX_BRIDGE_HOME may legitimately
 * reach it through a link. Below that root, links and junctions stay and are named, never read
 * through or removed. Walking ancestors first prevents even an lstat below a discovered link.
 * Only ENOENT means gone; every other read failure must stay visible to a later removal planner.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  HOME_ARTIFACTS,
  HOME_DIRECTORIES,
  classifyHomePath,
  homeArtifact,
} from '../src/home/lib/home-registry.mjs';

function knownDirectories(imageMembers) {
  const directories = new Set(HOME_DIRECTORIES);
  const addAncestors = (relative) => {
    let parent = path.posix.dirname(relative);
    while (parent !== '.' && parent !== '/') {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  };
  for (const artifact of HOME_ARTIFACTS) {
    if (Array.isArray(artifact.primary)) {
      for (const relative of artifact.primary) addAncestors(relative);
    } else {
      directories.add(artifact.primary.dir);
      addAncestors(artifact.primary.dir);
    }
  }
  for (const relative of imageMembers) addAncestors(relative);
  return directories;
}

const byRelative = (left, right) => (
  left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0
);

export function inspectHome(brandRoot, {
  imageMembers = [],
  lstat = fs.lstatSync,
  readdir = fs.readdirSync,
} = {}) {
  const result = {
    root: 'present',
    rootCode: null,
    files: [],
    unknown: [],
    links: [],
    errors: [],
    directories: [],
  };
  try {
    // D4 deliberately follows the root itself, unlike every entry below it.
    if (!fs.statSync(brandRoot).isDirectory()) {
      result.root = 'error';
      result.rootCode = 'ENOTDIR';
      return result;
    }
  } catch (error) {
    result.root = error.code === 'ENOENT' ? 'missing' : 'error';
    result.rootCode = error.code === 'ENOENT' ? null : error.code;
    return result;
  }

  const known = knownDirectories(imageMembers);
  const recordError = (relative, error) => {
    if (error.code !== 'ENOENT') result.errors.push({ relative, code: error.code });
  };
  const walk = (relative) => {
    const absolute = relative ? path.join(brandRoot, ...relative.split('/')) : brandRoot;
    let names;
    try {
      names = readdir(absolute);
    } catch (error) {
      recordError(relative, error);
      return error.code !== 'ENOENT';
    }
    for (const name of names) {
      const child = relative ? `${relative}/${name}` : name;
      let stats;
      try {
        stats = lstat(path.join(absolute, name));
      } catch (error) {
        recordError(child, error);
        continue;
      }
      if (stats.isSymbolicLink()) {
        result.links.push({ relative: child });
      } else if (stats.isFile()) {
        const match = classifyHomePath(child, { imageMembers });
        if (match) {
          result.files.push({ relative: child, ...match, removal: homeArtifact(match.id).removal });
        } else {
          result.unknown.push({ relative: child, kind: 'file' });
        }
      } else if (stats.isDirectory()) {
        // An undeclared folder is unknown as a whole: its contents cannot be ours, and an
        // operator's large folder (a backup, a checkout) must not be walked to say so.
        if (known.has(child)) {
          if (walk(child)) result.directories.push({ relative: child });
        } else {
          result.unknown.push({ relative: child, kind: 'directory' });
        }
      } else {
        result.unknown.push({ relative: child, kind: 'other' });
      }
    }
    return true;
  };
  walk('');
  for (const list of [result.files, result.unknown, result.links, result.errors]) list.sort(byRelative);
  // Deepest first: the order in which a later empty-folder removal can take them down.
  result.directories.sort((left, right) => (
    right.relative.split('/').length - left.relative.split('/').length || byRelative(left, right)
  ));
  return result;
}
