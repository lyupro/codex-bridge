/** Guards Plan_80 E19: doctor evidence shares one local-time run-record sample. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scanRunRecords } from '../../cli/doctor-run-records.mjs';
import { withTempTree } from '../temp-tree.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date(2026, 9, 15, 12).getTime();
const recent = '2026-10-14_100000';

function record(root, run = recent, { project = 'project', meta = { status: 'OK' }, status = { state: 'done' } } = {}) {
  const runDir = path.join(root, project, run);
  fs.mkdirSync(runDir, { recursive: true });
  for (const [name, value] of Object.entries({ meta, status })) {
    if (value !== undefined) fs.writeFileSync(path.join(runDir, `${name}.json`), JSON.stringify(value));
  }
  return runDir;
}

function scan(root, options = {}) {
  return scanRunRecords({ runsRoot: root, now, ...options });
}

test('empty scan returns explicit totals and the default 30-day window', async (t) => {
  await withTempTree('doctor-records-empty-', (root) => {
    t.mock.method(Date, 'now', () => now);
    assert.deepEqual(scanRunRecords({ runsRoot: root }), {
      records: [], unreadable: 0, statusUnreadable: 0, days: 30,
      windowStart: now - 30 * DAY_MS, windowEnd: now,
    });
  });
});

test('both window bounds are inclusive, suffixes accepted, and out-of-window runs unread', async (t) => {
  await withTempTree('doctor-records-window-', (root) => {
    const start = record(root, '2026-09-15_120000-advisor');
    const end = record(root, '2026-10-15_120000');
    const excluded = [
      record(root, '2026-09-15_115959'), record(root, '2026-10-15_120001'),
      record(root, 'not-a-run'), record(root, '2026-99-15_120000'),
    ];
    const read = fs.readFileSync;
    const reads = t.mock.method(fs, 'readFileSync', (file, ...args) => {
      assert.ok(!excluded.some((folder) => path.dirname(file) === folder));
      return read(file, ...args);
    });
    const result = scan(root);
    assert.deepEqual(result.records.map(({ runDir }) => runDir), [start, end]);
    assert.equal(reads.mock.callCount(), 4);
    assert.equal(result.windowStart, now - 30 * DAY_MS);
    assert.equal(result.windowEnd, now);
  });
});

test('folder timestamps are interpreted in local time rather than UTC', async () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Pacific/Honolulu';
  try {
    await withTempTree('doctor-records-local-', (root) => {
      const localNow = new Date(2026, 9, 15, 12).getTime();
      assert.notEqual(new Date(localNow).getTimezoneOffset(), 0);
      const runDir = record(root, '2026-10-15_120000-local');
      record(root, '2026-10-15_115959');
      record(root, '2026-10-15_120001');
      const result = scan(root, { now: localNow, days: 0 });
      assert.deepEqual(result.records, [{
        project: 'project', run: '2026-10-15_120000-local', runDir,
        status: { state: 'done' }, meta: { status: 'OK' },
      }]);
      assert.equal(result.windowStart, localNow);
      assert.equal(result.windowEnd, localNow);
      assert.equal(result.days, 0);
    });
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('.git and non-directories are skipped at both project and run levels', async (t) => {
  await withTempTree('doctor-records-entries-', (root) => {
    record(root, recent, { project: '.git' });
    fs.writeFileSync(path.join(root, 'plain-file'), 'not a project');
    fs.mkdirSync(path.join(root, 'project', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'project', recent), 'not a run');
    const runDir = record(root, `${recent}-valid`);
    const readdir = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (folder, ...args) => {
      assert.notEqual(path.basename(folder), '.git');
      return readdir(folder, ...args);
    });
    assert.deepEqual(scan(root).records.map((entry) => entry.runDir), [runDir]);
  });
});

test('missing meta is not damage; broken and unreadable meta count once and are skipped', async (t) => {
  await withTempTree('doctor-records-meta-', (root) => {
    const missing = path.join(root, 'project', `${recent}-missing`);
    fs.mkdirSync(missing, { recursive: true });
    // Plan_80 E12: a missing meta file is normal for a live or abandoned run.
    const read = fs.readFileSync;
    const broken = record(root, `${recent}-broken`);
    fs.writeFileSync(path.join(broken, 'meta.json'), '{');
    const denied = record(root, `${recent}-denied`);
    const good = record(root, `${recent}-good`);
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === path.join(denied, 'meta.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return read(file, ...args);
    });
    const result = scan(root);
    assert.equal(result.unreadable, 2);
    assert.equal(result.statusUnreadable, 0);
    assert.deepEqual(result.records.map(({ runDir }) => runDir), [good]);
  });
});

test('missing, broken, and unreadable status only affect statusUnreadable and leave null status', async (t) => {
  await withTempTree('doctor-records-status-', (root) => {
    const missing = path.join(root, 'project', `${recent}-missing`);
    fs.mkdirSync(missing, { recursive: true });
    fs.writeFileSync(path.join(missing, 'meta.json'), JSON.stringify({ status: 'OK' }));
    const broken = record(root, `${recent}-broken`);
    fs.writeFileSync(path.join(broken, 'status.json'), '{');
    const denied = record(root, `${recent}-denied`);
    const good = record(root, `${recent}-good`);
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === path.join(denied, 'status.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return read(file, ...args);
    });
    const result = scan(root);
    assert.equal(result.unreadable, 0);
    assert.equal(result.statusUnreadable, 3);
    assert.equal(result.records.length, 4);
    for (const entry of result.records) {
      assert.deepEqual(entry.status, entry.runDir === good ? { state: 'done' } : null);
      assert.deepEqual(entry.meta, { status: 'OK' });
    }
  });
});

test('BOM JSON is accepted and metadata is preserved without calibration filtering', async () => {
  await withTempTree('doctor-records-json-', (root) => {
    const runDir = record(root, recent, { meta: { status: 'FAIL' } });
    fs.writeFileSync(path.join(runDir, 'meta.json'), '\uFEFF{"status":"FAIL"}');
    fs.writeFileSync(path.join(runDir, 'status.json'), '\uFEFF{"state":"failed"}');
    const result = scan(root);
    assert.deepEqual(result.records, [{ project: 'project', run: recent, runDir,
      status: { state: 'failed' }, meta: { status: 'FAIL' } }]);
    assert.equal(result.unreadable, 0);
    assert.equal(result.statusUnreadable, 0);
  });
});

test('each sampled run reads meta.json once', async (t) => {
  await withTempTree('doctor-records-once-', (root) => {
    const dirs = [record(root), record(root, `${recent}-second`, { project: 'other' })];
    const read = fs.readFileSync;
    const reads = new Map();
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (path.basename(file) === 'meta.json') reads.set(file, (reads.get(file) ?? 0) + 1);
      return read(file, ...args);
    });
    assert.equal(scan(root).records.length, 2);
    assert.deepEqual(reads, new Map(dirs.map((dir) => [path.join(dir, 'meta.json'), 1])));
  });
});

test('an unavailable root returns only the exact root error text', async (t) => {
  await withTempTree('doctor-records-root-error-', (root) => {
    t.mock.method(fs, 'readdirSync', () => { throw new Error('EACCES: root denied'); });
    assert.deepEqual(scan(root), { error: 'runs root unavailable: EACCES: root denied' });
  });
});

test('an unavailable project discards partial totals and returns only the exact scan error text', async (t) => {
  await withTempTree('doctor-records-project-error-', (root) => {
    record(root, recent, { project: 'a-readable' });
    const denied = path.join(root, 'z-denied');
    fs.mkdirSync(denied);
    const readdir = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (folder, ...args) => {
      if (folder === denied) throw new Error('EACCES: project denied');
      const entries = readdir(folder, ...args);
      return folder === root ? entries.sort((a, b) => a.name.localeCompare(b.name)) : entries;
    });
    assert.deepEqual(scan(root), { error: 'runs root scan unavailable: EACCES: project denied' });
  });
});
