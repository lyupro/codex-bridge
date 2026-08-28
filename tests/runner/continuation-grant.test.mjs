/** Guards the line-shaped continuation grant boundary before attach or a new run can happen. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { parseContinuationGrant } from '../../src/home/lib/required-inputs.mjs';
import { resolveProjectRunsDir } from '../../src/home/lib/runner/project-dir.mjs';

const RUN_CODEX = fileURLToPath(new URL('../../src/home/lib/run-codex.mjs', import.meta.url));
const AGENT = 'codex-build';
const SLUG = 'continuation-grant';
const ORDER_ID = 'order-32';
const LAST_RUN = '2026-08-10_220535_plan25-2-install-table-two-roots';
const OUTCOME_REASON = 'run stopped on its deadline after 1500014 ms';
const GRANT_REASON = 'retry the unfinished verification';

function fixture(t) {
  const root = makeTempTree('continuation-grant-');
  t.after(() => removeTempTree(root));
  return root;
}

function runner(args, input, runsRoot, repo) {
  return spawnSync(process.execPath, [RUN_CODEX, ...args], {
    cwd: repo,
    env: { ...process.env, CODEX_RUNS_ROOT: runsRoot },
    input,
    encoding: 'utf8',
  });
}

function createPriorRun(project, repo) {
  const runDir = path.join(project, LAST_RUN);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'status.json'),
    JSON.stringify({
      state: 'finished',
      pid: process.pid,
      agent: AGENT,
      repo,
      slug: SLUG,
      order_id: ORDER_ID,
      started_at: '2026-08-10T22:05:35.000Z',
    }) + '\n',
  );
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status: 'FAIL', reason: OUTCOME_REASON }) + '\n');
  fs.writeFileSync(path.join(runDir, 'reply.txt'), 'OK\n');
}

function runFolders(project) {
  return fs.readdirSync(project, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function args(repo, withContinue = false) {
  return [
    '--agent', AGENT,
    '--repo', repo,
    '--slug', SLUG,
    '--order-id', ORDER_ID,
    '--scope', 'src/existing.mjs',
    ...(withContinue ? ['--continue'] : []),
  ];
}

test('a grant without --continue refuses before attach and names the repair details', (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'repo');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'existing.mjs'), 'export default 1;\n');
  const project = resolveProjectRunsDir(runsRoot, repo).dir;
  createPriorRun(project, repo);

  const output = runner(args(repo), `The order needs a second pass.\ncontinue: ${LAST_RUN} — ${GRANT_REASON}\n`, runsRoot, repo);

  assert.equal(output.status, 2, output.stderr);
  assert.match(output.stderr, /--continue is required/);
  assert.match(output.stderr, new RegExp(`Last run: ${LAST_RUN}`));
  assert.match(output.stderr, new RegExp(`Outcome: FAIL — ${OUTCOME_REASON}`));
  assert.match(output.stderr, new RegExp(`Ready grant line: continue: ${LAST_RUN} — ${GRANT_REASON}`));
  assert.doesNotMatch(output.stdout, /ATTACH=/);
  assert.deepEqual(runFolders(project), [LAST_RUN]);
});

test('a --continue flag without a grant keeps the existing refusal', (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'repo');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'existing.mjs'), 'export default 1;\n');
  const project = resolveProjectRunsDir(runsRoot, repo).dir;
  createPriorRun(project, repo);

  const output = runner(args(repo, true), 'The order asks for the existing work only.\n', runsRoot, repo);

  assert.equal(output.status, 2, output.stderr);
  assert.match(output.stderr, /did not provide a `continue:` grant/);
  assert.doesNotMatch(output.stdout, /ATTACH=/);
  assert.deepEqual(runFolders(project), [LAST_RUN]);
});

test('prose mentioning the continuation label is not a grant', () => {
  const prose = 'The word continue: is discussed here, but this paragraph does not order a continuation.';
  assert.equal(parseContinuationGrant(prose), null);
});
