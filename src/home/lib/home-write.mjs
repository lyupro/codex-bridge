/**
 * Performs a write into the package home only when the path belongs to the artifact id it names.
 *
 * The registry alone is a list someone can forget to consult; routing the write through it is what
 * makes `uninstall --purge` complete by construction (Plan_62 D22). The check is lexical and
 * in-memory — no lock, no stat, no listing — because hooks call it on every shell command of every
 * session, and links are deliberately not resolved, as everywhere else in the package.
 */
import fs from 'node:fs';
import path from 'node:path';
import { classifyHomePath, HOME_ARTIFACTS, HOME_DIRECTORIES } from './home-registry.mjs';

function registryError(id, absolutePath, reason) {
  const error = new Error(`Home artifact "${id}" refused path "${absolutePath}": ${reason}`);
  error.code = 'EHOMEREGISTRY';
  return error;
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function homeRelativePath(root, id, absolutePath) {
  if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) {
    throw registryError(id, absolutePath, 'an absolute path is required');
  }
  const relativeNative = path.relative(root, absolutePath);
  if (
    path.isAbsolute(relativeNative)
    || relativeNative === '..'
    || relativeNative.startsWith(`..${path.sep}`)
  ) {
    throw registryError(id, absolutePath, 'path is outside the home root');
  }
  return toPosix(relativeNative);
}

function directoryContainsArtifact(entry, relativeDirectory, imageMembers) {
  if (Array.isArray(entry.primary)) {
    if (entry.primary.some((candidate) => candidate.startsWith(`${relativeDirectory}/`))) return true;
  } else if (
    entry.primary.dir === relativeDirectory
    || entry.primary.dir.startsWith(`${relativeDirectory}/`)
  ) {
    return true;
  }

  if (entry.id === 'install-image') {
    return imageMembers.some((candidate) => candidate.startsWith(`${relativeDirectory}/`));
  }
  return false;
}

function directoryIsAllowed(id, relativeDirectory, imageMembers) {
  const entry = HOME_ARTIFACTS.find((candidate) => candidate.id === id);
  if (!entry) return false;
  if (relativeDirectory === '') return true;

  if (
    HOME_DIRECTORIES.includes(relativeDirectory)
    && directoryContainsArtifact(entry, relativeDirectory, imageMembers)
  ) {
    return true;
  }

  if (entry.id === 'install-image') {
    return imageMembers.some((candidate) => {
      const slash = candidate.lastIndexOf('/');
      const parent = slash < 0 ? '' : candidate.slice(0, slash);
      return parent === relativeDirectory;
    });
  }

  if (Array.isArray(entry.primary)) {
    return entry.primary.some((candidate) => {
      const slash = candidate.lastIndexOf('/');
      const parent = slash < 0 ? '' : candidate.slice(0, slash);
      return parent === relativeDirectory;
    });
  }
  return entry.primary.dir === relativeDirectory;
}

function recursiveOptions(options) {
  if (typeof options === 'string') return { encoding: options, recursive: true };
  return { ...options, recursive: true };
}

export function createHomeWriter({ root, imageMembers } = {}) {
  const homeRoot = path.resolve(root);
  const declaredImageMembers = Object.freeze([...(imageMembers ?? [])]);

  function assertArtifactPath(id, absolutePath) {
    const relativePath = homeRelativePath(homeRoot, id, absolutePath);
    const artifact = classifyHomePath(relativePath, { imageMembers: declaredImageMembers });
    if (!artifact || artifact.id !== id) {
      throw registryError(id, absolutePath, 'path is not declared for this artifact id');
    }
  }

  function assertDirectoryPath(id, absolutePath) {
    const relativeDirectory = homeRelativePath(homeRoot, id, absolutePath);
    if (!directoryIsAllowed(id, relativeDirectory, declaredImageMembers)) {
      throw registryError(id, absolutePath, 'directory is not an allowed artifact directory');
    }
  }

  return {
    // Plan_65 B2: a helper whose first write is a shared parent (`state/`) checks the target here, so a
    // wrong id is refused before mkdir creates anything — without opening the file to find out.
    assertArtifact(id, absolutePath) {
      assertArtifactPath(id, absolutePath);
    },
    writeFileSync(id, absolutePath, ...args) {
      assertArtifactPath(id, absolutePath);
      return fs.writeFileSync(absolutePath, ...args);
    },
    writeFile(id, absolutePath, ...args) {
      assertArtifactPath(id, absolutePath);
      return fs.promises.writeFile(absolutePath, ...args);
    },
    mkdirSync(id, absolutePath, options) {
      assertDirectoryPath(id, absolutePath);
      return fs.mkdirSync(absolutePath, recursiveOptions(options));
    },
    mkdir(id, absolutePath, options) {
      assertDirectoryPath(id, absolutePath);
      return fs.promises.mkdir(absolutePath, recursiveOptions(options));
    },
    openSync(id, absolutePath, ...args) {
      assertArtifactPath(id, absolutePath);
      return fs.openSync(absolutePath, ...args);
    },
    open(id, absolutePath, ...args) {
      assertArtifactPath(id, absolutePath);
      return fs.promises.open(absolutePath, ...args);
    },
    renameSync(id, oldAbsolutePath, newAbsolutePath) {
      assertArtifactPath(id, oldAbsolutePath);
      assertArtifactPath(id, newAbsolutePath);
      return fs.renameSync(oldAbsolutePath, newAbsolutePath);
    },
    rename(id, oldAbsolutePath, newAbsolutePath) {
      assertArtifactPath(id, oldAbsolutePath);
      assertArtifactPath(id, newAbsolutePath);
      return fs.promises.rename(oldAbsolutePath, newAbsolutePath);
    },
    copyFile(id, sourceAbsolutePath, destinationAbsolutePath, ...args) {
      assertArtifactPath(id, destinationAbsolutePath);
      return fs.promises.copyFile(sourceAbsolutePath, destinationAbsolutePath, ...args);
    },
    unlinkSync(id, absolutePath) {
      assertArtifactPath(id, absolutePath);
      return fs.unlinkSync(absolutePath);
    },
    unlink(id, absolutePath) {
      assertArtifactPath(id, absolutePath);
      return fs.promises.unlink(absolutePath);
    },
    rmdirSync(id, absolutePath) {
      assertDirectoryPath(id, absolutePath);
      return fs.rmdirSync(absolutePath);
    },
  };
}
