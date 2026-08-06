/** Verifies projects command levels, JSON output, refusal, and table rendering. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projects } from '../../cli/projects.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-command-'));
  const project = path.join(root, 'sample');
  const run = path.join(project, '2026-08-06_090000_sample');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify({
    agent: 'sample-agent',
    status: 'PASS',
    tokens: 21,
    finished_at: '2026-08-06T09:00:00.000Z',
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('projects without a name renders a project summary table', (t) => {
  const root = fixture(t);

  const result = projects([], { runsRootPath: root, terminalWidth: 120 });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /^project\s+runs\s+size\s+total tokens\s+live now\s+last run/);
  // Bytes and ISO milliseconds are what the inventory holds, not what it prints.
  assert.match(result.output, /\d+(\.\d)? (B|KB|MB|GB)/);
  assert.match(result.output, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}(\s|$)/);
  assert.match(result.output, /sample/);
  assert.match(result.output, /21/);
});

test('a project name renders its run rows', (t) => {
  const root = fixture(t);

  const result = projects(['sample'], { runsRootPath: root, terminalWidth: 120 });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /^run\s+agent\s+verdict\s+tokens\s+size/);
  assert.match(result.output, /sample-agent/);
  assert.match(result.output, /PASS/);
});

// A narrow terminal printed `running` as `…nning`, which reads as a damaged run rather than one
// still in flight. Long names are what a narrow table shortens; a verdict is one whole word.
test('a narrow table shortens the run name, never the verdict', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-narrow-'));
  const run = path.join(root, 'sample', '2026-08-06_090000_a-deliberately-long-run-name');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify({
    agent: 'codex-build',
    status: 'running',
    tokens: 21,
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = projects(['sample'], { runsRootPath: root, terminalWidth: 40 });

  assert.match(result.output, /\brunning\b/);
  assert.doesNotMatch(result.output, /…\w*nning/);
  assert.match(result.output, /…/, 'the run name is what a narrow table gives up');
});

test('--json emits the same project row shape as the inventory', (t) => {
  const root = fixture(t);

  const result = projects(['--json'], { runsRootPath: root });
  const rows = JSON.parse(result.output);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(Object.keys(rows[0]), [
    'project', 'runs', 'size', 'totalTokens', 'liveNow', 'lastRun',
  ]);
  assert.equal(rows[0].project, 'sample');
  assert.equal(rows[0].totalTokens, 21);
});

test('unknown project names are refused with a non-zero exit code', (t) => {
  const root = fixture(t);

  const result = projects(['missing'], { runsRootPath: root });

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /unknown project "missing"/);
});
