/** Verifies that runner provenance fields do not become part of the guarded run path. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const GUARD = fileURLToPath(new URL('../../src/home/hooks/reply-guard.mjs', import.meta.url));

test('cleanRunDir keeps only the folder from the new ATTACH line shape', (t) => {
  const root = makeTempTree('reply-guard-order-id-');
  t.after(() => removeTempTree(root));
  const runDir = path.join(root, '2026-08-15_090000_plan42-run2');
  fs.mkdirSync(runDir);
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status: 'OK' }));

  const input = JSON.stringify({
    agent_type: 'codex-review',
    agent_id: `reply-guard-${process.pid}-${Date.now()}`,
    cwd: root,
    last_assistant_message:
      `ATTACH=${runDir} order-id=plan42-run2-one-forbidden-list started=2026-08-15T09:00:00.000Z\n` +
      'OK — guarded verdict',
  });
  const output = spawnSync(process.execPath, [GUARD], {
    env: { ...process.env, HOME: root, USERPROFILE: root },
    input,
    encoding: 'utf8',
  });

  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout, '');
});
