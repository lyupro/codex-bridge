/** Guards Plan_78 B1 attribution so old incidents cannot prescribe a repair for a new probe. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withTempTree } from '../temp-tree.mjs';
import { resolveCodexHome } from '../../src/home/lib/codex-home.mjs';
import { snapshotSandboxLogs, diagnoseSandbox, formatSandboxDiagnosis }
  from '../../src/home/lib/runner/sandbox-diagnosis.mjs';

const now = new Date(2026, 9, 10, 12);
const NO_REPAIR = 'No verified repair signature; inspect this log.';
const locked = 'setup error: runtime read/execute validation failed: C:\\Codex\\runtimes\\file.dll: '
  + 'open ACL target for root-only update: C:\\Codex\\runtimes\\file.dll (os error 32)';
const corrupt = 'setup error: deny_read_acl_state.json: expected value at line 1 column 1';
const signatures = [
  { id: 'runtime-file-locked', line: locked, fragments: [
    'runtime read/execute validation failed', 'open ACL target for root-only update', 'os error 32',
  ] },
  { id: 'deny-read-state-corrupt', line: corrupt, fragments: [
    'deny_read_acl_state.json', 'expected value at line 1 column 1',
  ] },
];

function fixture(codexHome, date = now) {
  const folder = path.join(codexHome, '.sandbox');
  fs.mkdirSync(folder, { recursive: true });
  const stamp = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-');
  return { log: path.join(folder, `sandbox.${stamp}.log`), setup: path.join(folder, 'setup_error.json') };
}

function diagnose(codexHome, before, date = now) {
  return diagnoseSandbox({ codexHome, before, now: date });
}

// All file fixtures live in suite-owned throwaway trees, including resolver paths.
test('Codex home uses only a non-empty string override and otherwise the supplied home', async () => {
  await withTempTree('sandbox-resolver-', async (home) => {
    const override = path.join(home, 'custom Codex');
    assert.equal(resolveCodexHome({ env: { CODEX_HOME: override }, homedir: home }), override);
    for (const CODEX_HOME of [undefined, '', null, 42]) {
      assert.equal(resolveCodexHome({ env: { CODEX_HOME }, homedir: home }), path.join(home, '.codex'));
    }
    assert.equal(resolveCodexHome({ env: {}, homedir: home }), path.join(home, '.codex'));
    assert.equal(resolveCodexHome({ env: { CODEX_HOME: ' ' }, homedir: home }), ' ');
    assert.equal(resolveCodexHome(), typeof process.env.CODEX_HOME === 'string' && process.env.CODEX_HOME
      ? process.env.CODEX_HOME : path.join(os.homedir(), '.codex'));
  });
});

test('snapshot records local today and yesterday sizes and setup text', async () => {
  await withTempTree('sandbox-snapshot-', async (codexHome) => {
    const { log, setup } = fixture(codexHome);
    const previous = fixture(codexHome, new Date(2026, 9, 9));
    fs.writeFileSync(log, 'today\n');
    fs.writeFileSync(previous.log, 'yesterday\n');
    fs.writeFileSync(setup, '{"errors":[]}');
    const before = snapshotSandboxLogs({ codexHome, now });
    assert.deepEqual(before.logs, [{ path: log, size: 6 }, { path: previous.log, size: 10 }]);
    assert.equal(before.setupError.text, '{"errors":[]}');
  });
});

for (const { id, line, fragments } of signatures) {
  test(`${id} matches an appended incident and formats its verified repair`, async () => {
    await withTempTree('sandbox-signature-', async (codexHome) => {
      const { log } = fixture(codexHome);
      fs.writeFileSync(log, 'old setup succeeded\n');
      const before = snapshotSandboxLogs({ codexHome, now });
      fs.appendFileSync(log, `${line}\r\nsetup refresh completed with errors\r\n`);
      const result = diagnose(codexHome, before);
      assert.equal(result.attributed, true);
      assert.equal(result.signature.id, id);
      assert.deepEqual(result.lines, [line, 'setup refresh completed with errors']);
      assert.deepEqual(result.sources, [log]);
      const rows = formatSandboxDiagnosis(result);
      assert.ok(rows.includes(`> ${line}`));
      assert.ok(rows.some((row) => row.includes(log)));
      assert.ok(rows.some((row) => row.includes('attributed to this probe')));
      assert.ok(rows.includes(result.signature.summary));
      assert.ok(rows.includes(result.signature.repair));
      assert.equal(rows.includes(NO_REPAIR), false);
      assert.equal(rows.some((row) => /quota|run folder/i.test(row)), false);
      assert.match(result.signature.repair, /codex-bridge doctor/);
      if (id === 'runtime-file-locked') {
        assert.match(result.signature.summary, /openai\/codex #51634/);
        assert.match(result.signature.repair, /Codex CLI 0\.162\.x/);
        assert.match(result.signature.repair, /npm install -g @openai\/codex@0\.160\.1/);
        assert.match(result.signature.repair, /computer-use helper/);
      } else {
        assert.ok(result.signature.repair.includes(path.join(codexHome, '.sandbox', 'deny_read_acl_state.json')));
        assert.match(result.signature.repair, /Back up and rename/);
      }
    });
  });
  for (const fragment of fragments) {
    test(`${id} without ${fragment} gives no verified repair`, async () => {
      await withTempTree('sandbox-near-miss-', async (codexHome) => {
        const { log } = fixture(codexHome);
        const before = snapshotSandboxLogs({ codexHome, now });
        fs.writeFileSync(log, `${line.replace(fragment, 'unknown detail')}\n`);
        const result = diagnose(codexHome, before);
        assert.equal(result.attributed, true);
        assert.equal(result.signature, null);
        assert.equal(formatSandboxDiagnosis(result).at(-1), NO_REPAIR);
      });
    });
  }
  test(`${id} before the snapshot cannot explain a fresh unknown error`, async () => {
    await withTempTree('sandbox-old-error-', async (codexHome) => {
      const { log } = fixture(codexHome);
      fs.writeFileSync(log, `${line}\n`);
      const before = snapshotSandboxLogs({ codexHome, now });
      fs.appendFileSync(log, 'setup error: unknown cause\n');
      const result = diagnose(codexHome, before);
      assert.equal(result.attributed, true);
      assert.deepEqual(result.lines, ['setup error: unknown cause']);
      assert.equal(result.signature, null);
      assert.equal(formatSandboxDiagnosis(result).at(-1), NO_REPAIR);
    });
  });
}

test('fragments spread across different appended lines never match a signature', async () => {
  await withTempTree('sandbox-split-signature-', async (codexHome) => {
    const { log } = fixture(codexHome);
    const before = snapshotSandboxLogs({ codexHome, now });
    fs.writeFileSync(log, signatures.flatMap(({ fragments }) => fragments.map((s) => `error: ${s}`)).join('\n'));
    assert.equal(diagnose(codexHome, before).signature, null);
  });
});

test('no appended bytes uses only the newest recent log and never produces a repair', async () => {
  await withTempTree('sandbox-recent-', async (codexHome) => {
    const { log } = fixture(codexHome);
    const previous = fixture(codexHome, new Date(2026, 9, 9));
    fs.writeFileSync(log, `${locked}\n`);
    fs.writeFileSync(previous.log, `${corrupt}\n`);
    fs.utimesSync(previous.log, new Date(2026, 9, 9), new Date(2026, 9, 9));
    fs.utimesSync(log, now, now);
    const before = snapshotSandboxLogs({ codexHome, now });
    const result = diagnose(codexHome, before);
    assert.equal(result.attributed, false);
    assert.deepEqual(result.lines, [locked]);
    assert.equal(result.signature, null);
    const rows = formatSandboxDiagnosis(result);
    assert.ok(rows.some((row) => row.includes('Recent') && row.includes('not attributed')));
    assert.equal(rows.at(-1), NO_REPAIR);
  });
});

test('missing sandbox folder and setup_error.json are safe and distinct from unknown', async () => {
  await withTempTree('sandbox-missing-', async (codexHome) => {
    const before = snapshotSandboxLogs({ codexHome, now });
    assert.ok(before.logs.every(({ size }) => size === 0));
    assert.equal(before.setupError.text, null);
    const result = diagnose(codexHome, before);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.lines, []);
    assert.equal(result.attributed, false);
    assert.equal(result.signature, null);
    assert.deepEqual(result.setupError, { text: null, changed: false });
    assert.equal(formatSandboxDiagnosis(result).at(-1), NO_REPAIR);
    fixture(codexHome);
    assert.equal(diagnose(codexHome, before).setupError.text, null);
  });
});

test('setup_error.json is capped at 8 KiB and changes without becoming a repair signature', async () => {
  await withTempTree('sandbox-setup-', async (codexHome) => {
    const { setup } = fixture(codexHome);
    fs.writeFileSync(setup, 'x'.repeat(9000));
    const before = snapshotSandboxLogs({ codexHome, now });
    assert.equal(before.setupError.text.length, 8192);
    assert.deepEqual(diagnose(codexHome, before).setupError, { text: 'x'.repeat(8192), changed: false });
    fs.writeFileSync(setup, locked);
    const result = diagnose(codexHome, before);
    assert.deepEqual(result.setupError, { text: locked, changed: true });
    assert.ok(result.sources.includes(setup));
    assert.equal(result.signature, null);
    assert.ok(formatSandboxDiagnosis(result).includes(`> ${locked}`));
    assert.ok(formatSandboxDiagnosis(result).includes('setup_error.json changed since snapshot: yes'));
  });
});

test('new setup_error.json is marked changed from its missing snapshot', async () => {
  await withTempTree('sandbox-setup-created-', async (codexHome) => {
    const { setup } = fixture(codexHome);
    const before = snapshotSandboxLogs({ codexHome, now });
    fs.writeFileSync(setup, '{"errors":["new failure"]}');
    assert.deepEqual(diagnose(codexHome, before).setupError,
      { text: '{"errors":["new failure"]}', changed: true });
  });
});

test('large appended logs use offset reads capped at 64 KiB and discard the cut first line', async (t) => {
  await withTempTree('sandbox-bounded-', async (codexHome) => {
    const { log } = fixture(codexHome);
    fs.writeFileSync(log, 'old prefix\n');
    const before = snapshotSandboxLogs({ codexHome, now });
    // The tail starts inside this huge line; its surviving signature must be discarded.
    fs.appendFileSync(log, 'x'.repeat(70000) + locked + '\nerror: kept tail\n');
    const reads = [];
    const original = fs.readSync;
    t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
      reads.push({ length, position });
      return original(fd, buffer, offset, length, position);
    });
    t.mock.method(fs, 'readFileSync', () => { throw new Error('whole-file reads are forbidden'); });
    const result = diagnose(codexHome, before);
    assert.deepEqual(result.lines, ['error: kept tail']);
    assert.equal(result.attributed, true);
    assert.equal(result.signature, null);
    assert.deepEqual(reads, [{ length: 65536, position: fs.statSync(log).size - 65536 }]);
  });
});

test('recent fallback is bounded too and a truncated log never gains attribution', async () => {
  await withTempTree('sandbox-truncated-', async (codexHome) => {
    const { log } = fixture(codexHome);
    fs.writeFileSync(log, 'x'.repeat(100000) + locked + '\nerror: recent tail\n');
    const before = snapshotSandboxLogs({ codexHome, now });
    let result = diagnose(codexHome, before);
    assert.equal(result.attributed, false);
    assert.deepEqual(result.lines, ['error: recent tail']);
    fs.writeFileSync(log, `${corrupt}\n`);
    result = diagnose(codexHome, before);
    assert.equal(result.attributed, false);
    assert.deepEqual(result.lines, [corrupt]);
    assert.equal(result.signature, null);
  });
});

test('only the last five error lines are retained and each is cut to 400 characters', async () => {
  await withTempTree('sandbox-lines-', async (codexHome) => {
    const { log } = fixture(codexHome);
    const before = snapshotSandboxLogs({ codexHome, now });
    fs.writeFileSync(log, locked + '\n' + Array.from({ length: 7 }, (_, i) =>
      `info: routine activity\nERROR ${i}: ${'x'.repeat(500)}\n`).join(''));
    const result = diagnose(codexHome, before);
    assert.equal(result.lines.length, 5);
    assert.ok(result.lines.every((line) => line.length === 400));
    assert.match(result.lines[0], /^ERROR 2:/);
    assert.equal(result.signature, null);
  });
});

test('clean refresh lines with errors=[] never push the real error out of the kept lines', async () => {
  await withTempTree('sandbox-clean-refresh-', async (codexHome) => {
    const { log } = fixture(codexHome);
    const before = snapshotSandboxLogs({ codexHome, now });
    const clean = 'setup refresh: processed 0 write roots (read roots delegated); errors=[]';
    fs.writeFileSync(log, `${locked}\n${Array.from({ length: 6 }, () => clean).join('\n')}\n`);
    const result = diagnose(codexHome, before);
    assert.deepEqual(result.lines, [locked]);
    assert.equal(result.signature.id, 'runtime-file-locked');
  });
});

test('local midnight rollover reads appended records in both day files', async () => {
  await withTempTree('sandbox-midnight-', async (codexHome) => {
    const start = new Date(2026, 9, 10, 23, 59);
    const end = new Date(2026, 9, 11, 0, 1);
    const first = fixture(codexHome, start);
    fs.writeFileSync(first.log, `${locked}\n`);
    const before = snapshotSandboxLogs({ codexHome, now: start });
    fs.appendFileSync(first.log, 'error: before midnight\n');
    const second = fixture(codexHome, end);
    fs.writeFileSync(second.log, 'error: after midnight\n');
    const result = diagnose(codexHome, before, end);
    assert.deepEqual(result.sources, [first.log, second.log]);
    assert.deepEqual(result.lines, ['error: before midnight', 'error: after midnight']);
    assert.equal(result.attributed, true);
    assert.equal(result.signature, null);
  });
});

test('unreadable log and setup files are unknown rather than absent and cannot prove a repair', async (t) => {
  await withTempTree('sandbox-unreadable-', async (codexHome) => {
    const { log, setup } = fixture(codexHome);
    fs.writeFileSync(log, `${locked}\n`);
    fs.writeFileSync(setup, '{}');
    const stat = fs.statSync;
    const open = fs.openSync;
    const denied = () => Object.assign(new Error('permission denied'), { code: 'EACCES' });
    t.mock.method(fs, 'statSync', (file, ...args) => {
      if (file === log) throw denied();
      return stat(file, ...args);
    });
    t.mock.method(fs, 'openSync', (file, ...args) => {
      if (file === log || file === setup) throw denied();
      return open(file, ...args);
    });
    const before = snapshotSandboxLogs({ codexHome, now });
    assert.equal(before.logs[0].size, null);
    assert.match(before.setupError.text, /Unknown: unable to read/);
    const result = diagnose(codexHome, before);
    assert.equal(result.attributed, false);
    assert.equal(result.signature, null);
    assert.ok(result.lines.some((line) => line.includes('Unknown') && line.includes(log)));
    assert.match(result.setupError.text, /Unknown: unable to read/);
    assert.equal(result.setupError.changed, null);
    assert.ok(result.sources.includes(log));
    assert.ok(result.sources.includes(setup));
    assert.equal(formatSandboxDiagnosis(result).at(-1), NO_REPAIR);
  });
});

test('a newly readable log with an unknown snapshot size remains unattributed', async (t) => {
  await withTempTree('sandbox-baseline-unknown-', async (codexHome) => {
    const { log } = fixture(codexHome);
    fs.writeFileSync(log, `${locked}\n`);
    const stat = fs.statSync;
    const mock = t.mock.method(fs, 'statSync', (file, ...args) => {
      if (file === log) throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return stat(file, ...args);
    });
    const before = snapshotSandboxLogs({ codexHome, now });
    mock.mock.restore();
    const result = diagnose(codexHome, before);
    assert.equal(result.attributed, false);
    assert.equal(result.signature, null);
    assert.ok(result.lines.includes(locked));
    assert.ok(result.lines.some((line) => line.includes('pre-probe size unavailable')));
  });
});
