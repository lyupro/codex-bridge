/**
 * Checks filesystem write boundaries before tests start. Plan_62 D22 made package-home writes
 * removable only when they pass through the artifact adapter; Plan_65 B1b keeps that boundary
 * enforceable while existing writers are migrated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { lexSource } from './home-write-lexer.mjs';

const FILESYSTEM_MODULES = new Set(['node:fs', 'node:fs/promises', 'fs', 'fs/promises']);
const FILESYSTEM_WRITES = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync',
  'copyFile', 'copyFileSync', 'cp', 'cpSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync',
  'rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'open', 'openSync',
  'createWriteStream', 'symlink', 'symlinkSync', 'link', 'linkSync', 'truncate', 'truncateSync',
  'utimes', 'utimesSync',
];
const GENERIC_WRITES = ['writeJsonAtomic', 'withFileLock'];
const ADAPTER_MODULE = 'src/home/lib/home-write.mjs';

function modulePaths(repositoryRoot) {
  const modules = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) {
        modules.push(path.relative(repositoryRoot, fullPath).split(path.sep).join('/'));
      }
    }
  };
  for (const directory of ['src', 'cli', 'bin']) visit(path.join(repositoryRoot, directory));
  return modules.sort();
}

function importBindings(source, code, module, violations) {
  const bindings = [];
  const importPattern = /\bimport\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2/g;
  for (const match of source.matchAll(importPattern)) {
    if (!/^import\b/.test(code.slice(match.index))) continue;
    if (!FILESYSTEM_MODULES.has(match[3])) continue;
    const clauseOffset = match[0].indexOf(match[1]);
    const clause = match[1].trim();
    const leading = match[1].length - match[1].trimStart().length;
    const defaultBinding = clause.match(/^([A-Za-z_$][\w$]*)\b/);
    if (defaultBinding) {
      bindings.push({
        name: defaultBinding[1],
        declarationIndex: match.index + clauseOffset + leading,
      });
    }
    const namespaceBinding = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespaceBinding) {
      const localOffset = clause.indexOf(namespaceBinding[1], namespaceBinding.index);
      bindings.push({
        name: namespaceBinding[1],
        declarationIndex: match.index + clauseOffset + leading + localOffset,
      });
    }
    for (const named of clause.matchAll(/\{([^}]*)\}/g)) {
      for (const specifier of named[1].split(',')) {
        const parts = specifier.trim().split(/\s+as\s+/);
        const imported = parts[0].trim();
        if (FILESYSTEM_WRITES.includes(imported)) {
          violations.push({
            module,
            sink: `named-import:${imported}`,
            problem: `named filesystem write import${parts[1] ? ` as ${parts[1].trim()}` : ''} is forbidden`,
          });
        }
      }
    }
  }
  return bindings;
}

function assignedBinding(source, index) {
  const prefix = source.slice(Math.max(0, index - 100), index);
  const match = prefix.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
  if (!match) return null;
  return {
    name: match[1],
    declarationIndex: Math.max(0, index - 100) + match.index + match[0].indexOf(match[1]),
  };
}

function collectLoaderBindings(source, code, module, violations) {
  const bindings = [];
  const requirePattern = /\brequire\s*\(\s*(['"])(node:)?fs(?:\/promises)?\1\s*\)/g;
  for (const match of source.matchAll(requirePattern)) {
    if (!/^require\b/.test(code.slice(match.index))) continue;
    violations.push({ module, sink: 'require:fs', problem: 'filesystem module loaded with require()' });
    const binding = assignedBinding(source, match.index);
    if (binding) bindings.push(binding);
  }
  const dynamicPattern = /\bimport\s*\(\s*(['"])(node:)?fs(?:\/promises)?\1\s*\)/g;
  for (const match of source.matchAll(dynamicPattern)) {
    if (!/^import\b/.test(code.slice(match.index))) continue;
    violations.push({ module, sink: 'dynamic-import:fs', problem: 'filesystem module loaded with dynamic import()' });
    const binding = assignedBinding(source, match.index);
    if (binding) bindings.push(binding);
  }
  for (const match of source.matchAll(/\bcreateRequire\s*\(/g)) {
    if (!/^createRequire\b/.test(code.slice(match.index))) continue;
    violations.push({ module, sink: 'createRequire', problem: 'createRequire() can bypass filesystem binding checks' });
  }
  return bindings;
}

function valueUses(code, name) {
  const safe = escaped(name);
  const pattern = new RegExp(`\\b${safe}\\b`, 'g');
  for (const match of code.matchAll(pattern)) {
    const before = code.slice(0, match.index).match(/(?:\\?\.|\.)\s*$/);
    const after = code.slice(match.index + match[0].length).match(/^\s*(?:\?\.|\.)/);
    if (!before && !after) return true;
  }
  return false;
}

function collectBindings(source, code, module, violations) {
  const bindings = [
    ...importBindings(source, code, module, violations),
    ...collectLoaderBindings(source, code, module, violations),
  ];
  const byName = new Map();
  const add = (binding) => {
    const record = byName.get(binding.name) ?? { name: binding.name, declarations: new Set() };
    if (binding.declarationIndex !== undefined) record.declarations.add(binding.declarationIndex);
    byName.set(binding.name, record);
  };
  for (const binding of bindings) {
    add(binding);
  }

  let added;
  do {
    added = false;
    const declarations = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\r\n]+)/g;
    for (const match of code.matchAll(declarations)) {
      if (byName.has(match[1])) continue;
      if (![...byName.keys()].some((name) => valueUses(match[2], name))) continue;
      add({ name: match[1], declarationIndex: match.index + match[0].indexOf(match[1]) });
      added = true;
    }
  } while (added);
  return [...byName.values()];
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasDeclaration(code, name) {
  const safe = escaped(name);
  return new RegExp(`\\bfunction\\s+${safe}\\s*\\(|\\b(?:const|let|var)\\s+${safe}\\s*=`).test(code);
}

function callCounts(code, bindings, module, helperDefiners) {
  const counts = new Map();
  const writeAlternation = FILESYSTEM_WRITES.join('|');
  for (const { name: binding } of bindings) {
    const safe = escaped(binding);
    const calls = new RegExp(`\\b${safe}\\s*(?:\\?\\.\\s*|\\.\\s*)(?:promises\\s*\\.\\s*)?(${writeAlternation})\\s*(?:\\?\\.)?\\s*\\(`, 'g');
    for (const match of code.matchAll(calls)) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  for (const name of GENERIC_WRITES) {
    if (helperDefiners.get(name)?.has(module)) continue;
    const calls = new RegExp(`\\b${name}\\s*\\(`, 'g');
    for (const _match of code.matchAll(calls)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function scanModule({ module, original, actualCounts, violations, helperDefiners }) {
  if (module === ADAPTER_MODULE) return;
  const { code, withoutComments } = lexSource(original);
  const bindings = collectBindings(withoutComments, code, module, violations);
  const writeAlternation = FILESYSTEM_WRITES.join('|');
  for (const { name: binding, declarations } of bindings) {
    const safe = escaped(binding);
    const computed = new RegExp(`\\b${safe}\\s*(?:\\.\\s*promises\\s*)?\\s*\\[`, 'g');
    for (const match of code.matchAll(computed)) {
      violations.push({ module, sink: 'computed-fs-access', problem: 'computed access on filesystem binding is forbidden' });
    }
    const calls = new RegExp(`\\b${safe}\\s*(?:\\?\\.\\s*|\\.\\s*)(?:promises\\s*\\.\\s*)?(${writeAlternation})\\s*(?:\\?\\.)?\\s*\\(`, 'g');
    for (const match of code.matchAll(calls)) {
      const key = `${module}\0${match[1]}`;
      actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
    }
    const references = new RegExp(`\\b${safe}\\s*(?:\\.\\s*promises\\s*)?\\.\\s*(${writeAlternation})\\b(?!\\s*(?:\\?\\.)?\\s*\\()`, 'g');
    for (const match of code.matchAll(references)) {
      violations.push({ module, sink: `write-reference:${match[1]}`, problem: 'filesystem write function is referenced without a call' });
    }
    const assignment = new RegExp(`(?<![\\w$.])${safe}\\s*(?:=(?!=|>)|\\+=|-=|\\*=|\\/=|\\+\\+|--)`, 'g');
    for (const match of code.matchAll(assignment)) {
      if (declarations.has(match.index)) continue;
      const prefix = code.slice(Math.max(0, match.index - 30), match.index);
      if (!/\b(?:const|let|var)\s+$/.test(prefix)) {
        violations.push({ module, sink: 'fs-binding-reassigned', problem: 'filesystem binding is reassigned' });
      }
    }
    const bindingUses = new RegExp(`\\b${safe}\\b`, 'g');
    for (const match of code.matchAll(bindingUses)) {
      if (declarations.has(match.index)) continue;
      if (/(?:\\?\.|\.)\s*$/.test(code.slice(0, match.index))) continue;
      if (/^\s*(?:\?\.|\.)/.test(code.slice(match.index + match[0].length))) continue;
      const key = `${module}\0fs-binding-escape`;
      actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
    }
  }
  for (const [sink, count] of callCounts(code, bindings, module, helperDefiners)) {
    actualCounts.set(`${module}\0${sink}`, count);
  }
  const rawCounts = callCounts(withoutComments, bindings, module, helperDefiners);
  const maskedCounts = callCounts(code, bindings, module, helperDefiners);
  // A literal that swallowed code and a literal that is code (cli/probe-rig.mjs writes a hook's
  // source as a template) look the same to a lexer. Both are counted as `literal:<sink>` and must be
  // inventoried with their exact count, so a literal can be explained but never grow unnoticed.
  for (const [sink, rawCount] of rawCounts) {
    const hidden = rawCount - (maskedCounts.get(sink) ?? 0);
    if (hidden > 0) actualCounts.set(`${module} literal:${sink}`, hidden);
  }
}

function discoverHelperDefiners(modules, repositoryRoot) {
  const definers = new Map(GENERIC_WRITES.map((name) => [name, new Set()]));
  for (const module of modules) {
    const code = lexSource(fs.readFileSync(path.join(repositoryRoot, module), 'utf8')).code;
    for (const name of GENERIC_WRITES) {
      if (hasDeclaration(code, name)) definers.get(name).add(module);
    }
  }
  return definers;
}

/** Returns unaccounted writes, inventory count drift, and fail-closed binding violations. */
export function auditWrites({ repositoryRoot, inventory }) {
  const modules = modulePaths(repositoryRoot);
  const moduleSet = new Set(modules);
  const violations = [];
  const actualCounts = new Map();
  const inventoryCounts = new Map();
  for (const entry of inventory) {
    const key = `${entry.module}\0${entry.sink}`;
    if (inventoryCounts.has(key)) {
      violations.push({ module: entry.module, sink: entry.sink, problem: 'duplicate inventory entry' });
    }
    inventoryCounts.set(key, entry.count);
    if (!moduleSet.has(entry.module)) {
      violations.push({ module: entry.module, sink: entry.sink, problem: 'inventory entry names a missing module' });
    }
  }
  const helperDefiners = discoverHelperDefiners(modules, repositoryRoot);
  for (const module of modules) {
    scanModule({
      module,
      original: fs.readFileSync(path.join(repositoryRoot, module), 'utf8'),
      actualCounts,
      violations,
      helperDefiners,
    });
  }
  for (const [key, count] of actualCounts) {
    const [module, sink] = key.split('\0');
    const expected = inventoryCounts.get(key);
    if (expected === undefined) {
      violations.push({ module, sink, problem: `not inventoried (actual count ${count})` });
    } else if (count > expected) {
      violations.push({ module, sink, problem: `actual count ${count} exceeds inventory count ${expected}` });
    } else if (count < expected) {
      violations.push({ module, sink, problem: `actual count ${count} is below inventory count ${expected}` });
    }
  }
  for (const [key, expected] of inventoryCounts) {
    if (actualCounts.has(key)) continue;
    const [module, sink] = key.split('\0');
    if (moduleSet.has(module)) {
      violations.push({ module, sink, problem: `actual count 0 is below inventory count ${expected}` });
    }
  }
  violations.sort((left, right) => left.module.localeCompare(right.module)
    || left.sink.localeCompare(right.sink) || left.problem.localeCompare(right.problem));
  return { violations };
}
