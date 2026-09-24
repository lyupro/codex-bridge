/**
 * Plan_62 r2: on 2026-09-24 the reply guard judged a dispatcher's reply against the newest run of its
 * agent type, which belonged to an earlier order (`2026-09-23_135203_live-scout-phase`). With the order
 * id read from the dispatcher's transcript, another order's run is never a candidate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const GUARD = path.resolve(fileURLToPath(new URL('../../src/home/hooks/reply-guard.mjs', import.meta.url)));

test('a reply without a run folder is not judged against another order\'s recent run', async (t) => {
  const root = makeTempTree('bridge-reply-order-run-');
  t.after(() => removeTempTree(root));
  const repo = path.join(root, 'project');
  const runs = path.join(root, 'runs', 'project');
  const foreign = path.join(runs, '2026-09-23_135203_live-scout-phase');
  await fs.mkdir(foreign, { recursive: true });
  await fs.writeFile(path.join(runs, '.project.json'), `${JSON.stringify({ repo })}\n`);
  await fs.writeFile(path.join(foreign, 'status.json'), `${JSON.stringify({
    state: 'finished', status: 'OK', agent: 'codex-scout', order_id: 'earlier-order',
    finished_at: new Date(Date.now() - 1_000).toISOString(),
  })}\n`);
  const transcript = path.join(root, 'agent.jsonl');
  await fs.writeFile(transcript, `${JSON.stringify({
    type: 'user', message: { content: 'order id: this-order\ntask file: C:/abs/task.md' },
  })}\n`);

  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      agent_type: 'codex-scout',
      agent_id: 'order-run',
      agent_transcript_path: transcript,
      cwd: repo,
      last_assistant_message: 'OK — the answer is ready.',
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_RUNS_ROOT: path.join(root, 'runs'),
      HOME: root,
      USERPROFILE: root,
      CODEX_BRIDGE_HOME: path.join(root, '.lyupro', '.codex-bridge'),
    },
  });
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /no recent run for this dispatcher was found/);
  assert.ok(!decision.reason.includes('earlier-order') && !decision.reason.includes('live-scout-phase'));
});
