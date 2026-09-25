/**
 * Locks the Plan_65 B1b write-accounting rules in place. Plan_62 D22 showed that a prose-only
 * package-home boundary lets files survive purge without an owner or artifact id.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditWrites } from '../scripts/home-write-audit.mjs';
import { HOME_WRITE_INVENTORY } from '../scripts/home-write-inventory.mjs';
import { withTempTree } from './temp-tree.mjs';

const entry = (module, sink, count = 1) => ({
  module, sink, count, kind: 'outside-home', reason: 'fixture write outside package home',
});

async function auditFixture(files, inventory = []) {
  return withTempTree('home-write-audit-', async (repositoryRoot) => {
    for (const [module, contents] of Object.entries(files)) {
      const file = path.join(repositoryRoot, module);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    return auditWrites({ repositoryRoot, inventory });
  });
}

test('the real repository matches its frozen write inventory', () => {
  const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const { violations } = auditWrites({ repositoryRoot, inventory: HOME_WRITE_INVENTORY });
  assert.deepEqual(violations, []);
});

test('a new filesystem write is not inventoried', async () => {
  const { violations } = await auditFixture({ 'src/new-write.mjs': "import fs from 'node:fs'; fs.writeFileSync('x', 'y');" });
  assert.ok(violations.some(({ module, sink }) => module === 'src/new-write.mjs' && sink === 'writeFileSync'));
});

test('regex literals with quotes, backticks, and slashes do not hide writes', async (context) => {
  const exactJsonTokenRegex = String.raw`const tokens = [...raw.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g)];`;
  const fixtures = [
    ['the config-edit JSON token regex', `${exactJsonTokenRegex}\nawait fs.mkdir(dir);`],
    ['a backtick in a regex', 'const matcher = /`/; await fs.mkdir(dir);'],
    ['a slash in a regex character class', 'const matcher = /[/"]/; await fs.mkdir(dir);'],
  ];
  for (const [name, body] of fixtures) {
    await context.test(name, async () => {
      const { violations } = await auditFixture({
        'src/regex-write.mjs': `import fs from 'node:fs';\n${body}`,
      });
      assert.ok(violations.some(({ sink }) => sink === 'mkdir'));
      assert.ok(!violations.some(({ sink }) => sink.startsWith('literal:')));
    });
  }
});

test('a sink call hidden in a literal is counted and must be inventoried', async () => {
  const source = `import fs from 'node:fs';\nconst note = "fs.writeFileSync('x', 'y')";\nfs.mkdir('x');`;
  const { violations } = await auditFixture({ 'src/hidden-write.mjs': source });
  assert.ok(violations.some(({ sink, problem }) => sink === 'literal:writeFileSync' && /not inventoried/.test(problem)));
  const declared = await auditFixture({ 'src/hidden-write.mjs': source }, [
    { module: 'src/hidden-write.mjs', sink: 'literal:writeFileSync', count: 1, kind: 'outside-home', reason: 'fixture' },
    { module: 'src/hidden-write.mjs', sink: 'mkdir', count: 1, kind: 'outside-home', reason: 'fixture' },
  ]);
  assert.deepEqual(declared.violations, []);
});

test('filesystem bindings used as values are inventoried as escapes', async (context) => {
  const fixtures = [
    ['fallback alias', 'const filesystem = options.fs || fs;'],
    ['return value', 'function getFilesystem() { return fs; }'],
    ['object shorthand', 'const options = { fs };'],
    ['function argument', 'consume(fs);'],
  ];
  for (const [name, body] of fixtures) {
    await context.test(name, async () => {
      const { violations } = await auditFixture({
        'src/fs-escape.mjs': `import fs from 'node:fs';\n${body}`,
      });
      assert.ok(violations.some(({ sink }) => sink === 'fs-binding-escape'));
    });
  }
});

test('division operators do not mask subsequent filesystem writes', async (context) => {
  const fixtures = [
    ['chained division', 'const ratio = a / b / c; fs.writeFileSync("x", "y");'],
    ['division after assignment', 'x = y / 2; fs.writeFileSync("x", "y");'],
  ];
  for (const [name, body] of fixtures) {
    await context.test(name, async () => {
      const { violations } = await auditFixture({
        'src/division-write.mjs': `import fs from 'node:fs';\n${body}`,
      });
      assert.ok(violations.some(({ sink }) => sink === 'writeFileSync'));
      assert.ok(!violations.some(({ sink }) => sink.startsWith('literal:')));
    });
  }
});

test('an extra call in an excepted module fails its inventory count', async () => {
  const module = 'src/known-write.mjs';
  const { violations } = await auditFixture({
    [module]: "import fs from 'node:fs'; fs.writeFileSync('a', 'a'); fs.writeFileSync('b', 'b');",
  }, [entry(module, 'writeFileSync')]);
  assert.ok(violations.some(({ problem }) => problem === 'actual count 2 exceeds inventory count 1'));
});

test('a lower actual call count makes the exception stale', async () => {
  const module = 'src/known-write.mjs';
  const { violations } = await auditFixture({
    [module]: "import fs from 'node:fs'; fs.writeFileSync('a', 'a');",
  }, [entry(module, 'writeFileSync', 2)]);
  assert.ok(violations.some(({ problem }) => problem === 'actual count 1 is below inventory count 2'));
});

test('named filesystem write imports fail with and without aliases', async (context) => {
  for (const clause of ['writeFileSync', 'writeFileSync as write']) {
    await context.test(clause, async () => {
      const { violations } = await auditFixture({
        'src/named-write.mjs': `import { ${clause} } from 'node:fs';`,
      });
      assert.ok(violations.some(({ sink }) => sink === 'named-import:writeFileSync'));
    });
  }
});

test('computed filesystem access fails closed', async () => {
  const { violations } = await auditFixture({
    'src/computed-write.mjs': "import fs from 'node:fs'; fs['writeFileSync']('x', 'y');",
  });
  assert.ok(violations.some(({ sink }) => sink === 'computed-fs-access'));
});

test('a filesystem write function reference without a call fails closed', async () => {
  const { violations } = await auditFixture({
    'src/write-reference.mjs': "import fs from 'node:fs'; const writer = fs.writeFileSync;",
  });
  assert.ok(violations.some(({ sink }) => sink === 'write-reference:writeFileSync'));
});

test('generic caller-path sinks are accounted too', async () => {
  const { violations } = await auditFixture({
    'src/generic-write.mjs': 'writeJsonAtomic(file, value);',
  });
  assert.ok(violations.some(({ sink }) => sink === 'writeJsonAtomic'));
});

test('the home-write adapter is exempt', async () => {
  const { violations } = await auditFixture({
    'src/home/lib/home-write.mjs': "import fs from 'node:fs'; fs.writeFileSync('x', 'y');",
  });
  assert.deepEqual(violations, []);
});

test('read-only filesystem calls are allowed', async () => {
  const { violations } = await auditFixture({
    'src/read-only.mjs': "import fs from 'node:fs'; fs.readFileSync('x'); fs.existsSync('x');",
  });
  assert.deepEqual(violations, []);
});

test('filesystem loaders, reassignment, and escaping bindings fail closed', async (context) => {
  const fixtures = [
    "const fs = require('node:fs'); fs.writeFileSync('x', 'y');",
    "const fs = await import('node:fs'); fs.writeFileSync('x', 'y');",
    "import fs from 'node:fs'; fs = other;",
    "import fs from 'node:fs'; consume(fs);",
    "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url);",
  ];
  for (const [index, source] of fixtures.entries()) {
    await context.test(`loader or escaped binding ${index + 1}`, async () => {
      const { violations } = await auditFixture({ [`src/bypass-${index}.mjs`]: source });
      assert.ok(violations.length > 0);
    });
  }
});
