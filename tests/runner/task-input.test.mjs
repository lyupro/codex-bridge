/** Guards task-file/stdin selection before a run folder or paid process can exist. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { makeHomeImage } from '../home-image.mjs';
import { orderInvocation, orderTaskText } from './order-invocation.mjs';
import { repositoryRefusal } from '../../src/home/lib/runner/order-repository.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(ROOT, 'src', 'home', 'lib', 'run-codex.mjs');
const BIN = path.join(ROOT, 'bin', 'codex-bridge.mjs');

function fixture(t) {
  const root = makeTempTree('task-input-');
  t.after(() => removeTempTree(root));
  return root;
}

function args(taskFile) {
  // raw argv: task-channel tests need literal paths, missing files, and absent --task-file.
  return ['--agent', 'codex-build', ...(taskFile ? ['--task-file', taskFile] : [])];
}

function taskText(repo, task) {
  return orderTaskText({
    order: { repository: repo, 'order id': 'task-input', scope: 'C:/absolute-is-refused' }, advice: 'test-only', task,
  });
}

function run(entry, argv, root, input, extraEnv = {}) {
  return spawnSync(process.execPath, [entry, ...argv], {
    cwd: root,
    encoding: 'utf8',
    input,
    windowsHide: true,
    env: { ...process.env, CODEX_RUNS_ROOT: path.join(root, 'runs'), ...extraEnv },
  });
}

test('--task-file reads a non-empty task before later runner validation', (t) => {
  const root = fixture(t);
  const taskFile = path.join(root, 'task.md');
  fs.writeFileSync(taskFile, taskText(root, 'task from file'));
  // raw argv: this case tests reading the explicit --task-file channel.
  const result = run(RUNNER, args(taskFile), root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /`scope:` pattern/);
  assert.doesNotMatch(result.stderr, /task file.*empty|stdin is empty/);
});

test('missing and empty task files name the task-file channel', (t) => {
  const root = fixture(t);
  const empty = path.join(root, 'empty.md');
  fs.writeFileSync(empty, ' \n');
  // raw argv: the task-file path deliberately does not exist.
  const missingResult = run(RUNNER, args(path.join(root, 'missing.md')), root);
  assert.equal(missingResult.status, 2);
  assert.match(missingResult.stderr, /task file from --task-file could not be read/);
  // raw argv: the task file deliberately contains only whitespace.
  const emptyResult = run(RUNNER, args(empty), root);
  assert.equal(emptyResult.status, 2);
  assert.match(emptyResult.stderr, /task file from --task-file is empty/);
});

test('--task-file refuses relative paths with the received value', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'task.md'), 'wrong task from cwd\n');
  // raw argv: the task-file path must remain relative to test its refusal.
  const result = run(RUNNER, args('task.md'), root);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--task-file must be an absolute path; got "task\.md"/);
});

test('stdin remains the fallback and an empty stdin names that channel', (t) => {
  const root = fixture(t);
  // raw argv: the fallback channel must have no --task-file.
  const accepted = run(RUNNER, args(), root, taskText(root, 'task from stdin'));
  assert.equal(accepted.status, 2);
  assert.match(accepted.stderr, /`scope:` pattern/);
  // raw argv: empty stdin must remain empty and have no --task-file.
  const empty = run(RUNNER, args(), root, '');
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /task text on stdin is empty/);
});

test('non-empty stdin and --task-file refuse instead of choosing precedence', (t) => {
  const root = fixture(t);
  const taskFile = path.join(root, 'task.md');
  fs.writeFileSync(taskFile, taskText(root, 'task from file'));
  // raw argv: both input channels deliberately provide non-empty task text.
  const result = run(RUNNER, args(taskFile), root, taskText(root, 'task from stdin'));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /both stdin and --task-file/);
});

test('the direct file and package run command share task-channel output and exit code', async (t) => {
  const root = fixture(t);
  const taskFile = path.join(root, 'empty.md');
  fs.writeFileSync(taskFile, '');
  // raw argv: both entry points must receive the same deliberately empty task file.
  const argv = args(taskFile);
  const direct = run(RUNNER, argv, root);
  // raw argv: the package entry point requires its run subcommand for transport parity.
  const command = run(BIN, ['run', ...argv], root, undefined, { CODEX_BRIDGE_HOME: await makeHomeImage(t) });
  assert.equal(command.status, direct.status);
  assert.equal(command.stdout, direct.stdout);
  assert.equal(command.stderr, direct.stderr);
});

test('the direct file and package run command share the runner crash reply and exit code', async (t) => {
  const root = fixture(t);
  const runsRootFile = path.join(root, 'runs-root-file');
  fs.writeFileSync(runsRootFile, 'not a directory\n');
  const { argv } = orderInvocation({
    agent: 'codex-review', order: { repository: root, 'order id': 'crash-check' },
    task: 'force launcher crash', dir: root,
  });
  const env = { ...process.env, CODEX_RUNS_ROOT: runsRootFile };
  const direct = spawnSync(process.execPath, [RUNNER, ...argv], { cwd: root, encoding: 'utf8', windowsHide: true, env });
  // raw argv: the package entry point requires its run subcommand for crash parity.
  const command = spawnSync(process.execPath, [BIN, 'run', ...argv], {
    cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...env, CODEX_BRIDGE_HOME: await makeHomeImage(t) },
  });
  assert.equal(direct.status, 1);
  assert.equal(command.status, direct.status);
  assert.equal(command.stdout, direct.stdout);
  assert.match(command.stdout, /^FAIL — Codex runner crashed before creating the run folder:/);
  assert.equal(command.stderr, direct.stderr);
});

test('a malformed scout marker refuses before any run folder or quota is spent', (t) => {
  const root = fixture(t);
  const { argv } = orderInvocation({
    agent: 'codex-scout', order: { repository: root, 'order id': 'bad-marker' },
    task: 'Scout the startup context.', questions: ['[Context-Only] What were you handed?'], dir: root,
  });
  const result = run(RUNNER, argv, root);
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Q1/);
  assert.match(result.stderr, /\[context-only\]/);
  assert.match(result.stderr, /no quota was spent/);
  assert.equal(fs.existsSync(path.join(root, 'runs')), false);
});

test('OW-061: repository must be an existing absolute directory kept verbatim by Windows', (t) => {
  const root = fixture(t);
  assert.equal(repositoryRefusal(root), null);
  assert.match(repositoryRefusal('tradeforge.loc (do not cd into codex-runs).'), /must be an absolute path/);
  assert.match(repositoryRefusal(path.join(root, 'Obsidian. Run the scope phase.')), /ending in a dot or a space/);
  assert.match(repositoryRefusal(path.join(root, 'trailing ')), /ending in a dot or a space/);
  assert.match(repositoryRefusal(path.join(root, 'missing')), /must name an existing directory/);
  fs.writeFileSync(path.join(root, 'file.txt'), 'x');
  assert.match(repositoryRefusal(path.join(root, 'file.txt')), /must name an existing directory/);
});

test('OW-061: a phrase in repository is refused for free before a runs folder exists', (t) => {
  const root = fixture(t);
  const taskFile = path.join(root, 'task.md');
  fs.writeFileSync(taskFile, taskText('Obsidian. Run the scope phase.', 'task from file'));
  // raw argv: this case tests the explicit --task-file channel with a malformed repository value.
  const result = run(RUNNER, args(taskFile), root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /`repository:` must be an absolute path/);
  assert.match(result.stderr, /quota was not spent/);
  assert.equal(fs.existsSync(path.join(root, 'runs')), false);
});


// OW-073: exercise the fresh-launch boundary without starting Codex or spending quota.
function settleFrom(repo, agent, taskFile, input = '', setup = '') {
  const moduleUrl = new URL('../../src/home/lib/runner/task-input.mjs', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { settleTaskInput } from ${JSON.stringify(moduleUrl)};
    const opts = ${JSON.stringify({ agent, ...(taskFile ? { 'task-file': taskFile } : {}) })};
    const originalCwd = process.cwd();
    try {
      process.chdir(${JSON.stringify(repo)});
      ${setup}
      settleTaskInput(opts);
      console.log(JSON.stringify(opts));
    } catch (error) {
      process.exitCode = error.exitCode ?? 1;
    } finally {
      process.chdir(originalCwd);
    }
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', windowsHide: true, input,
  });
}

function repositoryOrder(agent, repository) {
  return orderTaskText({
    order: {
      'order id': 'ow-073', ...(repository === undefined ? {} : { repository }),
      ...(agent === 'codex-build' ? { scope: 'shared.mjs' } : {}),
      ...(agent === 'codex-advisor' ? { phase: 'scope' } : {}),
    },
    ...(agent === 'codex-build' ? { advice: 'test-only' } : {}),
    ...(agent === 'codex-scout' ? { questions: ['Where is shared.mjs used?'] } : {}),
    task: agent === 'codex-advisor'
      ? 'Choose a scope.\n\n## Options\n- A: Keep the shared module.\n- B: Split the shared module.\n\n## Paths\n- shared.mjs'
      : 'Inspect shared.mjs.',
  });
}

for (const agent of ['codex-scout', 'codex-build', 'codex-review', 'codex-advisor']) {
  test(`OW-073: ${agent} uses the task worktree and refuses ambiguous repository sources`, (t) => {
    const root = fixture(t);
    const repos = ['A', 'B'].map((name) => path.join(root, name));
    for (const repo of repos) {
      fs.mkdirSync(repo);
      const init = spawnSync('git', ['init', repo], { encoding: 'utf8', windowsHide: true });
      assert.ifError(init.error);
      assert.equal(init.status, 0, init.stderr);
      fs.writeFileSync(path.join(repo, 'shared.mjs'), 'export const shared = true;\n');
    }
    const [repoA, repoB] = repos;
    const taskFile = path.join(repoA, 'task.md');
    for (const label of [undefined, repoA]) {
      fs.writeFileSync(taskFile, repositoryOrder(agent, label));
      const accepted = settleFrom(repoB, agent, taskFile);
      assert.ifError(accepted.error);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(JSON.parse(accepted.stdout).repo, fs.realpathSync(repoA));
    }
    fs.writeFileSync(taskFile, repositoryOrder(agent, repoB));
    const mismatch = settleFrom(repoB, agent, taskFile);
    assert.equal(mismatch.status, 2, mismatch.stderr);
    assert.ok(mismatch.stderr.includes(JSON.stringify(fs.realpathSync(repoA))), mismatch.stderr);
    assert.ok(mismatch.stderr.includes(JSON.stringify(fs.realpathSync(repoB))), mismatch.stderr);
    assert.match(mismatch.stderr, /fix the label or move the task file/);
    assert.match(mismatch.stderr, /The run folder was not created; quota was not spent\./);


    // OW-073: a label disappearing between validation and resolution keeps the path refusal.
    const disappeared = settleFrom(repoB, agent, taskFile, '', `
      const stat = fs.statSync;
      let checks = 0;
      fs.statSync = (file, ...args) => file === ${JSON.stringify(repoB)} && ++checks > 1
        ? { isDirectory: () => false } : stat(file, ...args);
    `);
    assert.equal(disappeared.status, 2, disappeared.stderr);
    assert.match(disappeared.stderr, /must name an existing directory/);
    assert.doesNotMatch(disappeared.stderr, /fix the label or move the task file/);

    fs.writeFileSync(taskFile, repositoryOrder(agent));
    const discovery = settleFrom(repoB, agent, taskFile, '', `
      fs.realpathSync = () => { throw new Error('OW-073 discovery unavailable'); };
    `);
    assert.equal(discovery.status, 2, discovery.stderr);
    assert.match(discovery.stderr, /repository discovery failed: "OW-073 discovery unavailable"/);
    assert.match(discovery.stderr, /The run folder was not created; quota was not spent\./);

    fs.writeFileSync(taskFile, repositoryOrder(agent, 'relative-repository'));
    const invalidLabel = settleFrom(repoB, agent, taskFile, '', `
      fs.realpathSync = () => { throw new Error('discovery must not precede label validation'); };
    `);
    assert.equal(invalidLabel.status, 2, invalidLabel.stderr);
    assert.match(invalidLabel.stderr, /must be an absolute path to the repository/);
    assert.doesNotMatch(invalidLabel.stderr, /repository discovery failed/);

    const outsideTask = path.join(root, 'outside.md');
    fs.writeFileSync(outsideTask, repositoryOrder(agent));
    const outside = settleFrom(repoB, agent, outsideTask);
    assert.equal(outside.status, 2, outside.stderr);
    assert.ok(outside.stderr.includes(JSON.stringify(outsideTask)), outside.stderr);
    assert.match(outside.stderr, /requires a repository label; add repository: <absolute path>/);
    assert.match(outside.stderr, /The run folder was not created; quota was not spent\./);

    const stdin = settleFrom(repoB, agent, null, repositoryOrder(agent));
    assert.equal(stdin.status, 2, stdin.stderr);
    assert.match(stdin.stderr, /"stdin" requires a repository label; add repository: <absolute path>/);
    assert.match(stdin.stderr, /The run folder was not created; quota was not spent\./);

    fs.writeFileSync(outsideTask, repositoryOrder(agent, repoB));
    for (const [file, input] of [[outsideTask, ''], [null, repositoryOrder(agent, repoB)]]) {
      const labeled = settleFrom(repoA, agent, file, input);
      assert.equal(labeled.status, 0, labeled.stderr);
      assert.equal(JSON.parse(labeled.stdout).repo, fs.realpathSync(repoB));
    }
    assert.equal(fs.existsSync(path.join(root, 'runs')), false);
  });
}
