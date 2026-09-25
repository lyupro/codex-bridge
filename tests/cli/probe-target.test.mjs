/** Guards session-host selection after the 2026-09-25 PATH host identity incident. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { resolveProbeTarget } from '../../cli/probe-target.mjs';

function record(stateDir, hosts) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'host-observations.json'), JSON.stringify({ hosts, sessions: {} }));
}

function runner(versions) {
  return (executable) => ({ status: versions[executable] ? 0 : 1, stdout: versions[executable] ?? '' });
}

test('an explicit probe executable wins and its own version is measured', async () => {
  const root = makeTempTree('probe-target-flag-');
  try {
    const result = resolveProbeTarget({ stateDir: root, executable: 'chosen.exe', run: runner({ 'chosen.exe': '2.1.240 Claude' }) });
    assert.deepEqual(result, { executable: 'chosen.exe', version: '2.1.240', source: 'flag' });
  } finally { await removeTempTree(root); }
});

test('the newest observed host version selects the matching PATH executable', async () => {
  const root = makeTempTree('probe-target-newest-');
  try {
    record(root, { '2.1.239': { lastSeen: '2026-09-24T00:00:00Z' }, '2.1.240': { lastSeen: '2026-09-25T00:00:00Z' } });
    assert.deepEqual(resolveProbeTarget({ stateDir: root, run: runner({ claude: '2.1.240 Claude' }) }),
      { executable: 'claude', version: '2.1.240', source: 'observed' });
  } finally { await removeTempTree(root); }
});

test('the execpath candidate is used only when its measured version matches', async () => {
  const root = makeTempTree('probe-target-execpath-');
  try {
    record(root, { '2.1.240': { lastSeen: '2026-09-25T00:00:00Z' } });
    const options = { stateDir: root, env: { CLAUDE_CODE_EXECPATH: 'vscode.exe' }, exists: () => true };
    assert.deepEqual(resolveProbeTarget({ ...options, run: runner({ 'vscode.exe': '2.1.240 Claude', claude: '2.1.239 Claude' }) }),
      { executable: 'vscode.exe', version: '2.1.240', source: 'observed' });
    assert.deepEqual(resolveProbeTarget({ ...options, run: runner({ 'vscode.exe': '2.1.239 Claude', claude: '2.1.240 Claude' }) }),
      { executable: 'claude', version: '2.1.240', source: 'observed' });
  } finally { await removeTempTree(root); }
});

test('missing observations and unmatched candidates return actionable errors', async () => {
  const root = makeTempTree('probe-target-errors-');
  try {
    assert.match(resolveProbeTarget({ stateDir: root }).error, /No Claude Code session has been observed/);
    record(root, { '2.1.240': { lastSeen: '2026-09-25T00:00:00Z' } });
    const result = resolveProbeTarget({ stateDir: root, env: { CLAUDE_CODE_EXECPATH: 'vscode.exe' }, exists: () => true,
      run: runner({ 'vscode.exe': '2.1.239 Claude', claude: '2.1.238 Claude' }) });
    assert.match(result.error, /vscode\.exe \(2\.1\.239\), claude \(2\.1\.238\)/);
  } finally { await removeTempTree(root); }
});
