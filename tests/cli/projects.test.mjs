/** Verifies projects command levels, JSON output, refusal, and table rendering. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projects } from '../../cli/projects.mjs';
import { HEARTBEAT_FILE } from '../../src/home/lib/heartbeat.mjs';
import { STOP_COMMAND_TEMPLATE } from '../../src/home/lib/stop-contract.mjs';

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

// A folder name is written in local time, `finished_at` in UTC, and each used to reach the column
// through its own branch: the 2026-08-07 live check (Plan_17-1 §1) read a run whose folder says
// 14:42 as `12:46`, which is the machine's zone offset wearing the face of a different run. One
// moment, two shapes, one column — the printed strings have to agree, on any machine.
test('a UTC stamp and a folder name of the same moment print alike', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-clock-'));
  const iso = '2026-08-06T09:00:00.000Z';
  const at = new Date(iso);
  const pad = (value) => String(value).padStart(2, '0');
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const folder = `${day}_${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}_run`;

  const stamped = path.join(root, 'stamped', folder);
  fs.mkdirSync(stamped, { recursive: true });
  fs.writeFileSync(path.join(stamped, 'meta.json'), JSON.stringify({
    agent: 'codex-build',
    status: 'OK',
    tokens: 1,
    finished_at: iso,
  }));
  // No artifacts at all, so this project's timestamp can only come from the folder name.
  fs.mkdirSync(path.join(root, 'bare', folder), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const output = projects([], { runsRootPath: root, terminalWidth: 120 }).output;
  const stamps = [...output.matchAll(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/g)].map(([, stamp]) => stamp);

  assert.equal(stamps.length, 2, 'both projects must show a last run');
  assert.equal(stamps[0], stamps[1], 'the same moment must not print as two different times');
  assert.equal(stamps[0], `${day} ${pad(at.getHours())}:${pad(at.getMinutes())}`,
    'the column shows local time, the clock the folder names are written in');
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

test('projects reports the confirmed working-run count beside human tables', (t) => {
  const root = fixture(t);
  const run = path.join(root, 'sample', '2026-08-10_090000_active');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'status.json'), `${JSON.stringify({
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    slug: 'active',
    repo: process.cwd(),
  })}\n`);
  fs.writeFileSync(path.join(run, HEARTBEAT_FILE), 'progress\n');

  const result = projects([], { runsRootPath: root, terminalWidth: 120 });

  assert.equal(result.exitCode, 0);
  assert.ok(result.output.includes(`1 run working right now; stop with ${STOP_COMMAND_TEMPLATE}`));
});

test('unknown project names are refused with a non-zero exit code', (t) => {
  const root = fixture(t);

  const result = projects(['missing'], { runsRootPath: root });

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /unknown project "missing"/);
});
