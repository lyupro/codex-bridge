/**
 * Plan_57 D27: one judge owns recorded-run liveness after the reply guard's bare-pid
 * check mistook a reused pid for a live run and the project list printed `running`
 * for a dead run. Scan source and plant regressions in strings, never live files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JUDGE = 'src/home/lib/meta/run-liveness.mjs';
const DEFINITION = 'src/home/lib/process-identity.mjs';
const IDENTITY_APIS = ['processIdentity', 'probeProcessStart'];
const PID_POLLERS = new Map([
  // Attach polls a pid only after judging the recorded worker's identity before the loop.
  ['src/home/lib/runner/attach.mjs', 'Wait for an already-judged worker to exit or write its reply.'],
  // Stop polls a pid only after confirming identity and sending the stop signal.
  ['cli/stop.mjs', 'Wait for an already-judged and signaled worker to exit.'],
]);

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [file] : [];
  });
}

// Strings stay opaque so examples and comment text cannot impersonate imports or declarations.
function tokensWithoutComments(source) {
  const tokens = source.match(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*?\1|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_$][\w$]*|=>|[^\s]/g) || [];
  return tokens.filter((token) => !token.startsWith('//') && !token.startsWith('/*'));
}

const unquote = (token) => /^["'`]/.test(token || '') ? token.slice(1, -1) : token;
const identityModule = (token) => /(?:^|\/)process-identity\.mjs(?:[?#].*)?$/.test(unquote(token) || '');

function forbiddenImport(file, tokens) {
  if (file === DEFINITION) return false;
  for (let index = 0; index < tokens.length; index += 1) {
    const exporting = tokens[index] === 'export';
    if (tokens[index] !== 'import' && !exporting) continue;
    // Review 2026-09-17 (D28): `export { processIdentity as judge } from` builds a facade that every
    // consumer could import instead of the judge, so a re-export is checked like an import — and is
    // forbidden in every file, the judge included, since re-exporting is exactly the bypass.
    if (exporting && !['{', '*'].includes(tokens[index + 1])) continue;
    // Whole-module imports expose both identity probes and signal-0 polling, bypassing either
    // the single judge or the poller allowlist. Keep those boundaries explicit with named imports.
    if (!exporting && tokens[index + 1] === '(') {
      if (identityModule(tokens[index + 2])) return true;
      continue;
    }
    let end = index + 1;
    while (end < tokens.length && !['from', ';', 'import', 'export'].includes(tokens[end])) end += 1;
    if (tokens[end] !== 'from') continue;
    if (identityModule(tokens[end + 1]) && (exporting || tokens.slice(index + 1, end).includes('*'))) return true;
    for (let at = index + 1; at < end; at += 1) {
      // Inspect imported names, not their local aliases, including multiline import lists.
      if (at !== index + 1 && !['{', ','].includes(tokens[at - 1])) continue;
      const name = unquote(tokens[at]);
      if (IDENTITY_APIS.includes(name) && file !== JUDGE) return true;
      if (name === 'processAlive' && !PID_POLLERS.has(file)) return true;
    }
  }
  return false;
}

function pidFirstWrapper(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const functionName = token === 'function' ? index + (tokens[index + 1] === '*' ? 2 : 1) : null;
    const constName = ['const', 'let', 'var'].includes(token) ? index + 1 : null;
    const nameAt = functionName ?? constName;
    if (nameAt === null) continue;
    const name = tokens[nameAt];
    if (['isPidAlive', 'pidAlive'].includes(name)) return true;
    if (name !== 'alive') continue;
    if (functionName !== null) {
      if (tokens[nameAt + 1] === '(' && tokens[nameAt + 2] === 'pid') return true;
    } else if (tokens[nameAt + 1] === '=') {
      let start = nameAt + 2;
      if (tokens[start] === 'async') start += 1;
      if (tokens[start] === 'function') start += 1;
      if (tokens[start] === '(' && tokens[start + 1] === 'pid') return true;
      if (tokens[start] === 'pid' && tokens[start + 1] === '=>') return true;
    }
  }
  return false;
}

function offenders(files) {
  return files.filter(({ file, source }) => {
    const tokens = tokensWithoutComments(source);
    return forbiddenImport(file, tokens) || pidFirstWrapper(tokens);
  }).map(({ file }) => file).sort();
}

function assertOneJudge(files) {
  const found = offenders(files);
  assert.deepEqual(found, [], `Recorded-run liveness must use ${JUDGE}; only approved exit pollers may import processAlive. Offenders: ${found.join(', ')}`);
}

const sources = ['src', 'cli'].flatMap((directory) => sourceFiles(path.join(root, directory)))
  .map((file) => ({
    file: path.relative(root, file).replaceAll(path.sep, '/'),
    source: fs.readFileSync(file, 'utf8'),
  }));

test('src and cli use one liveness judge and only approved pid pollers', () => {
  for (const directory of ['src', 'cli']) assert.ok(sources.some(({ file }) => file.startsWith(`${directory}/`)));
  for (const file of [JUDGE, DEFINITION, ...PID_POLLERS.keys()]) {
    assert.ok(sources.some((source) => source.file === file), `${file} must exist`);
  }
  assertOneJudge(sources);
});

test('the guard rejects planted identity imports outside the judge', () => {
  for (const file of ['cli/new-reader.mjs', 'src/home/lib/new-reader.mjs', ...PID_POLLERS.keys()]) {
    for (const source of [
      "import { processIdentity } from '../src/home/lib/process-identity.mjs';",
      "import { processIdentity as judge } from './process-identity.mjs';",
      "import { probeProcessStart } from './process-identity.mjs';",
      "import {\n IDENTITY_ALIVE,\n probeProcessStart as probe,\n} from './process-identity.mjs';",
      "import { /* identity */ processIdentity } from './process-identity.mjs';",
    ]) {
      const planted = [...sources, { file, source }];
      assert.ok(offenders(planted).includes(file), `${file}: ${source}`);
      assert.throws(() => assertOneJudge(planted), { code: 'ERR_ASSERTION' }, source);
    }
  }
});

test('the guard restricts processAlive imports to the two documented pollers', () => {
  for (const file of ['cli/projects.mjs', 'src/home/lib/new-reader.mjs', JUDGE]) {
    for (const source of [
      "import { processAlive } from '../src/home/lib/process-identity.mjs';",
      "import { processAlive as poll } from './process-identity.mjs';",
    ]) {
      assert.deepEqual(offenders([{ file, source }]), [file], source);
      assert.throws(() => assertOneJudge([{ file, source }]), { code: 'ERR_ASSERTION' }, source);
    }
  }
});

// Review 2026-09-17 (D28): a facade re-export was invisible to an import-only scan.
test('re-exports of the identity module are rejected everywhere, the judge included', () => {
  for (const file of ['cli/new-reader.mjs', 'src/home/lib/identity-facade.mjs', JUDGE, ...PID_POLLERS.keys()]) {
    for (const source of [
      "export { processIdentity as judge } from './process-identity.mjs';",
      "export { processAlive } from '../src/home/lib/process-identity.mjs';",
      "export * from '../process-identity.mjs';",
      "export * as identity from './process-identity.mjs';",
      "export {\n  IDENTITY_ALIVE,\n  probeProcessStart,\n} from './process-identity.mjs';",
    ]) {
      assert.deepEqual(offenders([{ file, source }]), [file], `${file}: ${source}`);
    }
  }
  for (const source of [
    "export { runLiveness } from './run-liveness.mjs';",
    "const processIdentity = 1;\nexport { processIdentity };\nimport fs from 'node:fs';",
    "export function f() { return 1; }\nimport { heartbeatAge } from './heartbeat.mjs';",
  ]) {
    assert.deepEqual(offenders([{ file: 'cli/example.mjs', source }]), [], source);
  }
});

test('whole-module imports cannot bypass the judge or poller boundaries', () => {
  for (const file of ['cli/new-reader.mjs', JUDGE, ...PID_POLLERS.keys()]) {
    for (const source of [
      "import * as identity from '../src/home/lib/process-identity.mjs';",
      "const identity = await import('../src/home/lib/process-identity.mjs');",
    ]) {
      assert.deepEqual(offenders([{ file, source }]), [file], source);
      assert.throws(() => assertOneJudge([{ file, source }]), { code: 'ERR_ASSERTION' }, source);
    }
  }
});

test('the guard rejects pid-first wrapper declarations in every source file', () => {
  for (const file of ['cli/new-reader.mjs', JUDGE, DEFINITION, ...PID_POLLERS.keys()]) {
    for (const source of [
      'export const isPidAlive = (pid) => true;',
      'const pidAlive = (pid, runDir) => true;',
      'export function isPidAlive(record) { return true; }',
      'function pidAlive() { return true; }',
      'export const alive = (pid, runDir, status = {}) => true;',
      'function alive(pid) { return true; }',
      'export async function alive(pid, runDir) { return true; }',
      'const alive = async (pid) => true;',
      'const alive = pid => true;',
      'const alive = function(pid) { return true; };',
    ]) {
      assert.deepEqual(offenders([{ file, source }]), [file], source);
      assert.throws(() => assertOneJudge([{ file, source }]), { code: 'ERR_ASSERTION' }, source);
    }
  }
});

test('the guard permits the judge, definition and documented pollers', () => {
  for (const file of [JUDGE, DEFINITION]) {
    assertOneJudge([{ file, source: "import { processIdentity } from '../src/home/lib/process-identity.mjs';" }]);
    assertOneJudge([{ file, source: "import { probeProcessStart as probe } from '../process-identity.mjs';" }]);
  }
  for (const [file, reason] of PID_POLLERS) {
    assert.ok(reason);
    assertOneJudge([{ file, source: "import { processAlive } from '../process-identity.mjs';" }]);
  }
});

test('the guard ignores comments, strings and unrelated alive declarations', () => {
  for (const source of [
    '// processIdentity was here',
    "// import { processIdentity } from './process-identity.mjs';",
    "/* import { processAlive, probeProcessStart } from './process-identity.mjs'; */",
    '// export const isPidAlive = (pid) => true;',
    '/* function alive(pid) { return true; } */',
    'const example = "import { processIdentity } from \'./process-identity.mjs\';";',
    'const example = "export const isPidAlive = (pid) => true;";',
    'const alive = records.filter((record) => record.identity === IDENTITY_ALIVE);',
    'const alive = (record) => record.state === "running";',
    'function alive(status) { return status.state === "running"; }',
    "import { IDENTITY_ALIVE } from './process-identity.mjs';",
    "import * as unrelated from './unrelated.mjs';",
    "const unrelated = await import('./unrelated.mjs');",
  ]) {
    assert.deepEqual(offenders([{ file: 'cli/example.mjs', source }]), [], source);
  }
});
