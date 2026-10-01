/**
 * Guards structural reachability of every CLI module from the package binaries.
 * Plan_65 D13 retires an unused remover whose own tests concealed its lack of callers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXCEPTIONS = [];

// Computed import() in cli/hook.mjs and cli/run-launcher.mjs adds no static edge.
// This proves CLI structural reachability, not the runtime closure.
export function assertCliReachability({ graph, roots, cliFiles, exceptions, packageVersion }) {
  const exceptionFiles = exceptions.map((entry) => entry.module);
  assert.equal(new Set(exceptionFiles).size, exceptionFiles.length, 'Duplicate CLI reachability exception');
  assert.ok(exceptions.length <= 1, 'A new CLI reachability exception needs a new plan decision');
  for (const entry of exceptions) {
    assert.equal(entry.module, 'cli/purge-live-runs.mjs',
      'A new CLI reachability exception needs a new plan decision');
    assert.ok(Object.hasOwn(graph, entry.module), `Exception file is missing: ${entry.module}`);
    assert.ok(typeof entry.wiredBy === 'string' && entry.wiredBy.trim(),
      `Exception wiredBy must be nonempty: ${entry.module}`);
    assert.equal(entry.packageVersion, packageVersion,
      `Wire ${entry.module} by ${entry.wiredBy} before releasing; do not bump past its exception version`);
  }

  assert.ok(roots.length > 0, 'Package bin must provide at least one root');
  const reached = new Set();
  const queue = [...new Set(roots)];
  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index];
    if (reached.has(file)) continue;
    assert.ok(Object.hasOwn(graph, file), `Missing relative module target or package root: ${file}`);
    reached.add(file);
    if (!file.endsWith('.mjs')) continue;
    assert.ok(Array.isArray(graph[file]), `Module requests must be an array: ${file}`);
    for (const specifier of graph[file]) {
      assert.equal(typeof specifier, 'string', `Module specifier must be a string: ${file}`);
      if (!specifier.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      assert.ok(Object.hasOwn(graph, target), `Missing relative module target: ${file} -> ${specifier}`);
      queue.push(target);
    }
  }
  for (const file of exceptionFiles) {
    assert.ok(!reached.has(file), `Exception is reachable; retire the entry: ${file}`);
  }
  const disconnected = cliFiles.filter((file) => !reached.has(file)).sort();
  assert.deepEqual(disconnected, [...exceptionFiles].sort(),
    `Unreachable CLI modules must equal the exception set: ${disconnected.join(', ')}`);
  return reached;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const roots = [...new Set(Object.values(packageJson.bin))];
const cliFiles = fs.readdirSync(path.join(root, 'cli'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
  .map((entry) => `cli/${entry.name}`);
const sources = {
  'comment-string.mjs': `// import './x.mjs'
const s = "import './y.mjs'";`,
  'static-requests.mjs': `import './imported.mjs';
export { value } from './reexported.mjs';
export * from './star.mjs';
const target = './computed.mjs';
await import(target);
await import('./dynamic.mjs');`,
};
const child = spawnSync(process.execPath,
  ['--experimental-vm-modules', '--no-warnings', path.join(root, 'tests/module-requests.mjs')], {
    windowsHide: true,
    encoding: 'utf8',
    input: JSON.stringify({ root, files: [...new Set([...roots, ...cliFiles])], sources }),
  });
assert.ifError(child.error);
assert.equal(child.status, 0, `Static module parser failed: ${child.stderr || child.signal}`);
let parsed;
try {
  parsed = JSON.parse(child.stdout);
} catch (error) {
  assert.fail(`Static module parser returned invalid JSON: ${error.message}`);
}
assert.ok(parsed && typeof parsed.graph === 'object' && parsed.graph !== null, 'Parser graph is missing');
assert.ok(parsed.probes && typeof parsed.probes === 'object', 'Parser source probes are missing');

test('every CLI module is structurally reachable from a package binary', () => {
  const reached = assertCliReachability({
    graph: parsed.graph, roots, cliFiles, exceptions: EXCEPTIONS, packageVersion: packageJson.version,
  });
  assert.equal(roots.length, new Set(Object.values(packageJson.bin)).size);
  assert.ok([...reached].some((file) => file.startsWith('src/home/')), 'Follow CLI edges through home modules');
});

const fixtureException = { module: 'cli/purge-live-runs.mjs', wiredBy: 'Plan_65 B20', packageVersion: '0.6.8' };

function fixtureGraph() {
  return {
    graph: {
      'bin/start.mjs': ['../cli/entry.mjs'],
      'cli/entry.mjs': [],
      'cli/purge-live-runs.mjs': [],
    },
    roots: ['bin/start.mjs'],
    cliFiles: ['cli/entry.mjs', 'cli/purge-live-runs.mjs'],
    exceptions: [fixtureException],
    packageVersion: '0.6.8',
  };
}

test('a disconnected CLI module fails even when only tests import it', () => {
  for (const withTest of [false, true]) {
    const planted = fixtureGraph();
    planted.graph['cli/disconnected.mjs'] = [];
    planted.cliFiles.push('cli/disconnected.mjs');
    if (withTest) planted.graph['tests/caller.test.mjs'] = ['../cli/disconnected.mjs'];
    assert.throws(() => assertCliReachability(planted), /Unreachable CLI modules/);
  }
});

test('cycles count only when reached from a package root', () => {
  const planted = fixtureGraph();
  planted.graph['cli/first.mjs'] = ['./second.mjs'];
  planted.graph['cli/second.mjs'] = ['./first.mjs'];
  planted.cliFiles.push('cli/first.mjs', 'cli/second.mjs');
  assert.throws(() => assertCliReachability(planted), /Unreachable CLI modules/);
  planted.graph['cli/entry.mjs'] = ['./first.mjs'];
  const reached = assertCliReachability(planted);
  assert.ok(reached.has('cli/first.mjs'));
  assert.ok(reached.has('cli/second.mjs'));
});

test('the parser ignores comments, strings and dynamic imports but retains static reexports', () => {
  assert.deepEqual(parsed.probes['comment-string.mjs'], []);
  assert.deepEqual(parsed.probes['static-requests.mjs'],
    ['./imported.mjs', './reexported.mjs', './star.mjs']);
  const planted = fixtureGraph();
  planted.graph['cli/entry.mjs'] = parsed.probes['comment-string.mjs'];
  for (const name of ['x', 'y']) {
    planted.graph[`cli/${name}.mjs`] = [];
    planted.cliFiles.push(`cli/${name}.mjs`);
  }
  assert.throws(() => assertCliReachability(planted), /Unreachable CLI modules/);
});

test('relative edges through home modules are followed and missing targets fail loudly', () => {
  const planted = fixtureGraph();
  planted.graph['bin/start.mjs'] = ['node:fs', 'a-package', '../src/home/bridge.mjs'];
  planted.graph['src/home/bridge.mjs'] = ['../../cli/entry.mjs'];
  assert.ok(assertCliReachability(planted).has('cli/entry.mjs'));
  planted.graph['cli/entry.mjs'] = ['./missing.mjs'];
  assert.throws(() => assertCliReachability(planted), /Missing relative module target/);
});

test('invalid exceptions fail instead of concealing unused code or surviving a release', () => {
  const cases = [
    ['duplicate', (state) => { state.exceptions = [fixtureException, fixtureException]; }, /Duplicate/],
    ['missing file', (state) => { delete state.graph[fixtureException.module]; }, /Exception file is missing/],
    ['reachable', (state) => { state.graph['cli/entry.mjs'] = ['./purge-live-runs.mjs']; }, /retire the entry/],
    ['empty wiredBy', (state) => {
      state.exceptions = [{ ...fixtureException, wiredBy: '' }];
    }, /wiredBy must be nonempty/],
    ['blank wiredBy', (state) => {
      state.exceptions = [{ ...fixtureException, wiredBy: '  ' }];
    }, /wiredBy must be nonempty/],
    ['release version', (state) => { state.packageVersion = '0.6.9'; }, /before releasing/],
    ['multiple entries', (state) => {
      state.exceptions = [fixtureException, { ...fixtureException, module: 'cli/extra.mjs' }];
    }, /new plan decision/],
    ['different module', (state) => {
      state.exceptions = [{ ...fixtureException, module: 'cli/entry.mjs' }];
    }, /new plan decision/],
  ];
  for (const [label, mutate, message] of cases) {
    const planted = fixtureGraph();
    mutate(planted);
    assert.throws(() => assertCliReachability(planted), message, label);
  }
});
