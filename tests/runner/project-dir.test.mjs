/** Verifies stable project run directory ownership. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeRepoPath,
  PROJECT_MARKER,
  resolveProjectRunsDir,
} from '../../src/runner/project-dir.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-dir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function marker(dir, repo, created = '2026-08-02T10:00:00.000Z') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PROJECT_MARKER), `${JSON.stringify({ repo, created }, null, 2)}\n`);
}

function legacyRun(projectDir, name, repo) {
  const runDir = path.join(projectDir, name);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({ repo }));
}

function readMarker(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, PROJECT_MARKER), 'utf8'));
}

test('a free project name is created with its marker', (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repos', 'api');
  const result = resolveProjectRunsDir(runsRoot, repo);

  assert.equal(result.reason, 'created');
  assert.equal(result.name, 'api');
  assert.equal(fs.statSync(result.dir).isDirectory(), true);
  assert.equal(readMarker(result.dir).repo, repo);
});

test('a repeated call reuses the marker without replacing created', (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repos', 'api');
  const first = resolveProjectRunsDir(runsRoot, repo);
  const created = readMarker(first.dir).created;
  const second = resolveProjectRunsDir(runsRoot, repo);

  assert.equal(second.reason, 'marker');
  assert.equal(second.dir, first.dir);
  assert.equal(readMarker(second.dir).created, created);
});

test('a foreign marker in the base selects base-2', (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'ours', 'api');
  marker(path.join(runsRoot, 'api'), path.join(runsRoot, 'theirs', 'api'));

  const result = resolveProjectRunsDir(runsRoot, repo);

  assert.equal(result.name, 'api-2');
  assert.equal(result.reason, 'created');
});

test('foreign markers in two candidates select base-3', (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'ours', 'api');
  marker(path.join(runsRoot, 'api'), path.join(runsRoot, 'theirs-a', 'api'));
  marker(path.join(runsRoot, 'api-2'), path.join(runsRoot, 'theirs-b', 'api'));

  const result = resolveProjectRunsDir(runsRoot, repo);

  assert.equal(result.name, 'api-3');
});

test('a legacy folder owned by this repo is adopted', (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'ours', 'api');
  const base = path.join(runsRoot, 'api');
  legacyRun(base, '2026-08-01_090000_first', repo);

  const result = resolveProjectRunsDir(runsRoot, repo);

  assert.equal(result.reason, 'adopted');
  assert.equal(result.name, 'api');
  assert.equal(readMarker(base).repo, repo);
});

test('a legacy folder owned by another repo is pinned before base-2 is created', (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'ours', 'api');
  const foreignRepo = path.join(runsRoot, 'theirs', 'api');
  const base = path.join(runsRoot, 'api');
  legacyRun(base, '2026-08-01_090000_first', foreignRepo);

  const result = resolveProjectRunsDir(runsRoot, repo);

  assert.equal(result.name, 'api-2');
  assert.equal(readMarker(base).repo, foreignRepo);
});

test('mixed legacy history belongs to its first run', (t) => {
  const runsRoot = fixture(t);
  const repoA = path.join(runsRoot, 'a', 'api');
  const repoB = path.join(runsRoot, 'b', 'api');
  const base = path.join(runsRoot, 'api');
  legacyRun(base, '2026-08-01_090000_first', repoA);
  legacyRun(base, '2026-08-02_090000_later', repoB);

  const forA = resolveProjectRunsDir(runsRoot, repoA);
  const forB = resolveProjectRunsDir(runsRoot, repoB);

  assert.equal(forA.name, 'api');
  assert.equal(forA.reason, 'adopted');
  assert.equal(forB.name, 'api-2');
});

test('an empty legacy folder is adopted by the current repo', (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'ours', 'api');
  const base = path.join(runsRoot, 'api');
  fs.mkdirSync(base);

  const result = resolveProjectRunsDir(runsRoot, repo);

  assert.equal(result.reason, 'adopted');
  assert.equal(readMarker(base).repo, repo);
});

test('repo path normalization follows platform case rules', () => {
  if (process.platform === 'win32') {
    assert.equal(normalizeRepoPath(String.raw`C:\Repos\Api`), normalizeRepoPath('c:/repos/api/'));
  } else {
    assert.notEqual(normalizeRepoPath('/Repos/Api'), normalizeRepoPath('/repos/api/'));
  }
});

test('read-only resolution makes no changes and predicts the created candidate', (t) => {
  const parent = fixture(t);
  const runsRoot = path.join(parent, 'missing-runs');
  const repo = path.join(parent, 'repos', 'api');

  const inspected = resolveProjectRunsDir(runsRoot, repo, { create: false });

  assert.equal(inspected.reason, 'created');
  assert.equal(fs.existsSync(runsRoot), false);
  const created = resolveProjectRunsDir(runsRoot, repo);
  assert.deepEqual(inspected, created);
});
