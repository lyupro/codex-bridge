/**
 * OW-067 / Plan_81 D2: an in-place writer can leave a torn run record that readers treat as absent.
 * Keep the publisher as the only write path; exceptions below write other named artifacts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tokensOf } from '../source-tokens.mjs';

const rawSinks = new Set([
  'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'renameSync', 'rename',
  'copyFileSync', 'copyFile', 'openSync', 'open', 'createWriteStream',
]);
const allowed = new Map([
  ['src/home/lib/run-codex.mjs', 'Appends crash diagnostics to stderr.log; only reads meta.json.'],
  ['src/home/lib/runner/project-dir.mjs', 'Writes the ownership marker .project.json; only reads status.json.'],
  ['src/home/lib/runner/recovery-launch.mjs', 'Copies frozen environment bytes to env.json; only reads run records.'],
  ['src/home/lib/runner/resume-launch.mjs',
    'Writes frozen inputs such as task-original.md and schema.json, plus task.md and resume-note.md.'],
  ['src/home/lib/runner/run-autocommit.mjs', 'Appends failure diagnostics to stderr.log; only reads run records.'],
]);

function hasRecordAndSink(source) {
  const tokens = tokensOf(source);
  const hasRecord = tokens.some((token) => /^(['"`])(?:status|meta)\.json\1$/.test(token));
  return hasRecord && tokens.some((token) => rawSinks.has(token));
}

function checkWriters(sources, allowList) {
  const candidates = new Set(
    [...sources].filter(([, source]) => hasRecordAndSink(source)).map(([module]) => module),
  );
  const violations = [];
  for (const module of candidates) {
    if (!allowList.has(module)) violations.push(`${module}: raw sink alongside a run record`);
  }
  for (const [module, reason] of allowList) {
    if (!candidates.has(module)) violations.push(`${module}: stale allow-list entry`);
    if (typeof reason !== 'string' || !reason.trim()) violations.push(`${module}: missing reason`);
  }
  return violations;
}

function moduleSources(root) {
  const sources = new Map();
  function visit(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const module = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(module);
      else if (entry.name.endsWith('.mjs')) {
        sources.set(module, fs.readFileSync(path.join(root, module), 'utf8'));
      }
    }
  }
  visit('src');
  visit('cli');
  return sources;
}

test('status.json and meta.json are published only through writeRunJsonAtomic', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  assert.equal(allowed.has('src/home/lib/meta/run-state.mjs'), false);
  assert.equal(allowed.has('src/home/lib/write-meta.mjs'), false);
  assert.deepEqual(checkWriters(moduleSources(root), allowed), []);
});

test('the same checker rejects raw run-record write and rename mutations', () => {
  for (const source of [
    "fs.writeFileSync(path.join(runDir, 'meta.json'), text);",
    "fs.renameSync(temporary, path.join(runDir, 'status.json'));",
  ]) {
    assert.deepEqual(checkWriters(new Map([['src/fixture.mjs', source]]), new Map()), [
      'src/fixture.mjs: raw sink alongside a run record',
    ]);
  }
});

test('all raw sink names are guarded for both run records', () => {
  for (const sink of rawSinks) {
    for (const record of ['meta.json', 'status.json']) {
      const source = `fs.${sink}(path.join(runDir, '${record}'), text);`;
      assert.equal(checkWriters(new Map([['src/fixture.mjs', source]]), new Map()).length, 1);
    }
  }
});

test('reads, comments and unrelated strings do not introduce writers', () => {
  for (const source of [
    "fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8');",
    "// meta.json\nfs.writeFileSync(path.join(runDir, 'report.md'), text);",
    "/* 'meta.json' */ fs.writeFileSync('report.md', text);",
    "const note = 'meta.json is documented here'; fs.writeFileSync('report.md', text);",
    "const note = 'writeFileSync'; fs.readFileSync('meta.json');",
  ]) {
    assert.deepEqual(checkWriters(new Map([['src/fixture.mjs', source]]), new Map()), []);
  }
});

test('allow-list entries become stale when a module disappears or stops matching', () => {
  const allowList = new Map([['src/fixture.mjs', 'Writes stderr.log.']]);
  const source = "fs.readFileSync('meta.json'); fs.appendFileSync('stderr.log', text);";
  assert.deepEqual(checkWriters(new Map([['src/fixture.mjs', source]]), allowList), []);
  for (const sources of [
    new Map(),
    new Map([['src/fixture.mjs', "fs.readFileSync('meta.json');"]]),
    new Map([['src/fixture.mjs', "fs.appendFileSync('stderr.log', text);"]]),
  ]) {
    assert.deepEqual(checkWriters(sources, allowList), ['src/fixture.mjs: stale allow-list entry']);
  }
});
