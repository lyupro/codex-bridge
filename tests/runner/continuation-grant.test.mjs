/** Guards the line-shaped continuation grant boundary before attach or a new run can happen. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { parseTaskHeader } from '../../src/home/lib/task-header.mjs';
import { continuationRefusal } from '../../src/home/lib/runner/continuation.mjs';
import { resolveProjectRunsDir } from '../../src/home/lib/runner/project-dir.mjs';
import { launcherProcessMocks } from './launcher-mocks.mjs';
import { orderInvocation, orderTaskText } from './order-invocation.mjs';

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

function mockedRunner(args, input, runsRoot, repo, refuse = false) {
  const script = [
    "import childProcess from 'node:child_process';",
    "import { syncBuiltinESMExports } from 'node:module';",
    launcherProcessMocks({ worker: refuse ? 'forbidden' : 'spawn', probe: refuse ? 'forbidden' : 'marker' }),
    'syncBuiltinESMExports();',
    `const { runCodexCommand } = await import(${JSON.stringify(pathToFileURL(RUN_CODEX).href)});`,
    'const code = await runCodexCommand(process.argv.slice(1));',
    'if (code !== undefined) process.exitCode = code;',
  ].join('\n');
  // raw argv: isolate the mocked launcher; -- separates Node flags from transport arguments.
  return spawnSync(process.execPath, ['--input-type=module', '-e', script, '--', ...args], {
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

function invocation(repo, dir, grant) {
  return orderInvocation({
    agent: AGENT,
    order: { repository: repo, slug: SLUG, 'order id': ORDER_ID, scope: 'src/existing.mjs' },
    grant, advice: 'test-only', task: 'The order needs a second pass.', dir,
  });
}

test('a grant alone starts continuation without a separate flag', (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'repo');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'existing.mjs'), 'export default 1;\n');
  const project = resolveProjectRunsDir(runsRoot, repo).dir;
  createPriorRun(project, repo);

  const { argv } = invocation(repo, root, { kind: 'continue', run: LAST_RUN, reason: GRANT_REASON });
  const output = mockedRunner(argv, undefined, runsRoot, repo);

  assert.equal(output.status, 0, output.stderr);
  assert.doesNotMatch(output.stdout, /ATTACH=/);
  const folders = runFolders(project);
  assert.equal(folders.length, 2);
  const continued = folders.find((name) => name !== LAST_RUN);
  const status = JSON.parse(fs.readFileSync(path.join(project, continued, 'status.json'), 'utf8'));
  assert.equal(status.continued_from, LAST_RUN);
  assert.equal(status.order_id, ORDER_ID);
});

// Plan_75 D5: the old grant-after-prose layout must refuse before spending quota.
test('a grant after prose is refused for free as misplaced metadata and names its line', (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'repo');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'existing.mjs'), 'export default 1;\n');

  const { argv, taskFile } = invocation(repo, root);
  // Plan_63 D8: keep the misplaced grant after prose, following the required order header.
  fs.writeFileSync(taskFile,
    `order id: ${ORDER_ID}\nscope: src/existing.mjs\nadvice: test-only\n\nThe order needs a second pass.\ncontinue: ${LAST_RUN} \u2014 ${GRANT_REASON}\n`);
  const output = mockedRunner(argv, undefined, runsRoot, repo, true);

  assert.equal(output.status, 2, output.stderr);
  assert.equal(output.stdout, '');
  assert.match(output.stderr, /line 6: misplaced continue metadata/);
  assert.ok(output.stderr.includes(`continue: ${LAST_RUN} — ${GRANT_REASON}`), output.stderr);
  assert.match(output.stderr, /^The run folder was not created; quota was not spent\.$/m);
  assert.equal(fs.existsSync(runsRoot), false);
});

test('--continue is a closed flag before attach or run registration', (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'repo');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'existing.mjs'), 'export default 1;\n');
  const project = resolveProjectRunsDir(runsRoot, repo).dir;
  createPriorRun(project, repo);

  const { argv } = invocation(repo, root);
  // raw argv: Plan_63 D8 closes --continue; only a header grant authorizes continuation.
  const output = runner([...argv, '--continue'], undefined, runsRoot, repo);

  assert.equal(output.status, 2, output.stderr);
  assert.match(output.stderr, /unknown flag --continue/);
  assert.doesNotMatch(output.stdout, /ATTACH=/);
  assert.deepEqual(runFolders(project), [LAST_RUN]);
});

test('repeating a header continuation attaches to its run without creating another folder', (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'repo');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'existing.mjs'), 'export default 1;\n');
  const project = resolveProjectRunsDir(runsRoot, repo).dir;
  createPriorRun(project, repo);
  const invocation = {
    agent: AGENT,
    order: { repository: repo, slug: SLUG, 'order id': ORDER_ID, scope: 'src/existing.mjs' },
    grant: { kind: 'continue', run: LAST_RUN, reason: GRANT_REASON },
    advice: 'test-only', task: 'The order needs a second pass.',
  };
  const { argv: command } = orderInvocation({ ...invocation, dir: root });
  // Plan_63 D8: stdin carries the same header grant as the task-file channel.
  command.splice(command.indexOf('--task-file'), 2);
  const input = orderTaskText(invocation);

  const first = mockedRunner(command, input, runsRoot, repo);

  assert.equal(first.status, 0, first.stderr);
  const afterStart = runFolders(project);
  assert.equal(afterStart.length, 2);
  const continuation = afterStart.find((name) => name !== LAST_RUN);
  const continuationDir = path.join(project, continuation);
  fs.writeFileSync(path.join(continuationDir, 'meta.json'), '{"status":"OK"}\n');
  fs.writeFileSync(path.join(continuationDir, 'reply.txt'), 'OK — continuation answered\n');

  const repeated = mockedRunner(command, input, runsRoot, repo);

  assert.equal(repeated.status, 0, repeated.stderr);
  assert.ok(repeated.stdout.includes(`ATTACH=${continuationDir} order-id=${ORDER_ID}`), repeated.stdout);
  assert.match(repeated.stdout, /This is the answer of the previous run/);
  assert.match(repeated.stdout, /OK — continuation answered/);
  assert.doesNotMatch(`${repeated.stdout}\n${repeated.stderr}`, /`continue:` grant is refused/);
  assert.deepEqual(runFolders(project), afterStart);
});

test('prose mentioning the continuation label is not a grant', () => {
  const prose = 'The word continue: is discussed here, but this paragraph does not order a continuation.';
  assert.equal(parseTaskHeader(prose).grant, null);
});

// Plan_63 D9: loose prompt strings can no longer authorize continuation.
test('continuationRefusal treats a grant string as no grant', (t) => {
  const root = fixture(t);
  const text = `continue: ${LAST_RUN} — ${GRANT_REASON}`;
  for (const isContinue of [false, true]) {
    assert.equal(continuationRefusal(root, [LAST_RUN], isContinue, ORDER_ID, text), null);
    assert.equal(continuationRefusal(root, [LAST_RUN], isContinue, ORDER_ID, text),
      continuationRefusal(root, [LAST_RUN], isContinue, ORDER_ID, null));
  }
  assert.deepEqual(fs.readdirSync(root), []);
});
