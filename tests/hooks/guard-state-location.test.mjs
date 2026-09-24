/**
 * Holds the reply guard's try budget and diagnostics inside the package home: until Plan_62 D14 they
 * were written into Claude Code's own `~/.claude/logs/`, a shared folder the layout rule forbids.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const GUARD = path.resolve(fileURLToPath(new URL('../../src/home/hooks/reply-guard.mjs', import.meta.url)));

test('a blocked reply spends its try under state/ and writes nothing into ~/.claude/logs', async (t) => {
  const root = makeTempTree('bridge-guard-state-');
  t.after(() => removeTempTree(root));
  const brand = path.join(root, '.lyupro', '.codex-bridge');
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      agent_type: 'codex-build',
      agent_id: 'guard-state-location',
      last_assistant_message: 'I changed the files myself.',
    }),
    encoding: 'utf8',
    env: { ...process.env, CODEX_RUNS_ROOT: path.join(root, 'runs'), HOME: root, USERPROFILE: root, CODEX_BRIDGE_HOME: brand },
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).decision, 'block');

  const stateDir = path.join(brand, 'state');
  const tries = JSON.parse(await fs.readFile(path.join(stateDir, 'reply-guard-tries.json'), 'utf8'));
  assert.equal(tries['guard-state-location'].form, 1);
  await fs.access(path.join(stateDir, 'diagnostics', 'reply-guard.last.json'));
  await assert.rejects(fs.access(path.join(root, '.claude', 'logs')), { code: 'ENOENT' });
});
