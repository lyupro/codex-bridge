/** Plan_59 D5/D6: design gates must refuse before a probe or run folder exists. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from '../temp-tree.mjs';
import { launcherProcessMocks } from './launcher-mocks.mjs';
import { orderInvocation, orderTaskText } from './order-invocation.mjs';
import { taskPreflight } from '../../src/home/lib/runner/preflight.mjs';

const LAUNCHER = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;
const CLEAN_TASK = '## Options\n- keep: Keep the boundary.\n- split: Split the boundary.\n## Paths\n- source.mjs\n';
const FREE = /^The run folder was not created; quota was not spent\.$/m;

function fixture() {
  const root = makeTempTree('advice-gate-');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const runs = path.join(repo, 'runs');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(repo, 'source.mjs'), 'export default 1;\n');
  return { root, repo, home, runs };
}

function launch(tree, agent, taskText, { advice, refuse = false, taskFile = false, raw = false } = {}) {
  const order = { repository: tree.repo, 'order id': 'advice-fixture',
    ...(agent === 'codex-advisor' ? { phase: 'scope' } : {}),
    ...(agent === 'codex-build' ? { scope: 'source.mjs' } : {}) };
  let args;
  if (raw) {
    // Plan_63 D8: malformed task bytes follow the three-line build order header unchanged.
    const header = orderTaskText({ order }).split('\n\n', 1)[0];
    taskText = `${header}\n${taskText}`;
    // raw argv: syntax and empty-body cases need exact task bytes through either transport.
    args = ['--agent', agent];
    if (taskFile) {
      const file = path.join(tree.root, 'task.md');
      fs.writeFileSync(file, taskText);
      // raw argv: the file half of the raw-header matrix needs its explicit task path.
      args.push('--task-file', file);
    }
  } else {
    ({ argv: args } = orderInvocation({
      agent, order,
      advice, questions: agent === 'codex-scout' ? ['What does source.mjs export?'] : undefined,
      task: taskText, dir: tree.root,
    }));
  }
  const source = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
${launcherProcessMocks({ worker: refuse ? 'forbidden' : 'spawn', probe: refuse ? 'forbidden' : 'marker' })}
syncBuiltinESMExports();
const { launcher } = await import(${JSON.stringify(LAUNCHER)});
try { process.exitCode = await launcher(${JSON.stringify(args)}); }
catch (error) {
  if (typeof error?.exitCode !== 'number') throw error;
  process.exitCode = error.exitCode;
}
`;
  // raw argv: isolate the launcher with mocked process APIs in a Node module.
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: tree.repo, input: raw && !taskFile ? taskText : '', encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, CODEX_BRIDGE_HOME: tree.home, CODEX_RUNS_ROOT: tree.runs },
  });
}

function statusFrom(output) {
  assert.equal(output.status, 0, output.stderr || output.error?.message);
  const line = output.stdout.split(/\r?\n/).find((line) => line.startsWith('RUN='));
  assert.ok(line, output.stdout);
  return JSON.parse(fs.readFileSync(path.join(line.slice(4).split(' order-id=')[0], 'status.json'), 'utf8'));
}

const JUDGED_ADVICE = { agent: 'codex-advisor', phase: 'advise', status: 'OK' };

function assertFree(tree, output, exitCode = 1) {
  assert.equal(output.status, exitCode, output.stderr || output.error?.message);
  assert.equal(output.stdout, '');
  assert.match(output.stderr, FREE);
  assert.equal(fs.existsSync(tree.runs), false);
  assert.deepEqual(fs.readdirSync(tree.repo), ['source.mjs']);
}

for (const advice of ['mechanical', 'revert', 'docs-only', 'test-only']) {
  test(`build accepts ${advice} and persists advice in status`, () => {
    assert.equal(statusFrom(launch(fixture(), 'codex-build', 'Edit source.', { advice })).advice, advice);
  });
}

test('advice header accepts value whitespace and CRLF, including task files', () => {
  const output = launch(fixture(), 'codex-build', 'advice: \t docs-only \t\r\n\r\nEdit source.\r\n', { taskFile: true, raw: true });
  assert.equal(statusFrom(output).advice, 'docs-only');
});

test('an absolute advisor run path with spaces passes and is persisted', () => {
  const tree = fixture();
  const advisorRun = path.join(tree.root, 'finished advisor');
  fs.mkdirSync(advisorRun);
  fs.writeFileSync(path.join(advisorRun, 'meta.json'), JSON.stringify(JUDGED_ADVICE));
  assert.equal(statusFrom(launch(tree, 'codex-build', 'Edit source.', { advice: advisorRun })).advice, advisorRun);
});

test('advisor metadata uses the shared BOM-tolerant JSON reader', () => {
  const tree = fixture();
  fs.writeFileSync(path.join(tree.home, 'meta.json'), `\uFEFF${JSON.stringify(JUDGED_ADVICE)}\n`);
  assert.equal(statusFrom(launch(tree, 'codex-build', 'Edit source.', { advice: tree.home })).advice, tree.home);
});

const invalid = {
  missing: () => 'Edit source.',
  duplicate: () => 'advice: mechanical\n - ADVICE: revert',
  empty: () => 'advice: \nEdit source.',
  'free text': () => 'advice: the best choice',
  'inline label': () => 'Edit source with advice: mechanical',
  'wrong value case': () => 'advice: Mechanical',
  relative: () => 'advice: ./advisor',
  'nonexistent path': (tree) => `advice: ${path.join(tree.root, 'missing')}`,
  'directory without meta': (tree) => `advice: ${tree.home}`,
  'file path': (tree) => `advice: ${path.join(tree.repo, 'source.mjs')}`,
  'another agent': (tree) => {
    fs.writeFileSync(path.join(tree.home, 'meta.json'), JSON.stringify({ agent: 'codex-scout' }));
    return `advice: ${tree.home}`;
  },
  // Plan_59 D26: an advisor folder authorizes a build only as a judged, successful advise pass.
  'advisor scope run': (tree) => {
    fs.writeFileSync(path.join(tree.home, 'meta.json'), JSON.stringify({ ...JUDGED_ADVICE, phase: 'scope' }));
    return `advice: ${tree.home}`;
  },
  'failed advise run': (tree) => {
    fs.writeFileSync(path.join(tree.home, 'meta.json'), JSON.stringify({ ...JUDGED_ADVICE, status: 'FAIL' }));
    return `advice: ${tree.home}`;
  },
  'advisor run without phase': (tree) => {
    fs.writeFileSync(path.join(tree.home, 'meta.json'), JSON.stringify({ agent: 'codex-advisor', status: 'OK' }));
    return `advice: ${tree.home}`;
  },
  'malformed meta': (tree) => {
    fs.writeFileSync(path.join(tree.home, 'meta.json'), '{');
    return `advice: ${tree.home}`;
  },
};
for (const [name, task] of Object.entries(invalid)) {
  test(`build refuses ${name} without a probe or run folder`, () => {
    const tree = fixture();
    const text = task(tree);
    const raw = ['duplicate', 'empty', 'inline label'].includes(name);
    const output = launch(tree, 'codex-build', raw ? `${text}\n\nEdit source.` : 'Edit source.', {
      advice: text.startsWith('advice: ') ? text.slice('advice: '.length) : undefined,
      refuse: true, raw,
    });
    const headerError = name === 'duplicate' || name === 'empty';
    assertFree(tree, output, headerError ? 2 : 1);
    if (headerError) {
      assert.match(output.stderr, name === 'duplicate' ? /line 5: misplaced advice/ : /line 4: advice value must be non-empty/);
      return;
    }
    assert.match(output.stderr, /requires the task file to start with the header line `advice: <value>`/);
    if (name === 'inline label') assert.doesNotMatch(output.stderr, /misplaced/);
    assert.match(output.stderr, /mechanical \| revert \| docs-only \| test-only/);
    assert.match(output.stderr, /absolute path.*meta\.json.*codex-advisor/);
    assert.match(output.stderr, /an order that invents a construction needs a second opinion first; only work with no design choice may skip it/i);
  });
}

for (const agent of ['codex-scout', 'codex-review', 'codex-advisor']) {
  test(`${agent} runs without advice and has no advice status field`, () => {
    const task = agent === 'codex-advisor' ? CLEAN_TASK : 'Inspect source.';
    assert.equal(Object.hasOwn(statusFrom(launch(fixture(), agent, task)), 'advice'), false);
  });
}

// Plan_59 D5: retain the task-boundary guard alongside launcher coverage in advisor-run.test.mjs.
test('biased advisor task is refused by the task gate with the free-refusal sentence', () => {
  const text = CLEAN_TASK.replace('Keep the boundary.', 'Keep the boundary (recommended).');
  const { refusal } = taskPreflight({ agent: 'codex-advisor', taskText: text });
  assert.match(refusal, /remove preference marker/);
  assert.match(refusal, /The run folder was not created; quota was not spent\.$/);
});

test('clean advisor task is not refused by the task gate', () => {
  assert.equal(taskPreflight({ agent: 'codex-advisor', taskText: CLEAN_TASK }).refusal, null);
});
// Plan_75 D5, 2026-10-03 20:42: inspect raw lines before Verify can swallow a grant.
const malformedHeaders = [
  ['advice below the body', 'Edit source.\nadvice: mechanical', /line 5: misplaced advice.*: advice: mechanical/],
  ['duplicate header label', 'advice: mechanical\nadvice: revert\n\nEdit source.', /line 5: duplicate advice label/],
  ['decorated label below the header', 'advice: mechanical\n\nEdit source.\n**advice:** revert', /line 7: misplaced advice.*: \*\*advice:\*\* revert/],
  ['decorated first label', ' \t-  AdViCe \t: \t docs-only \t\r\n\r\nEdit source.', /line 4: misplaced advice/],
  ['grant hidden in Verify', 'advice: mechanical\n\nEdit source.\n## Verify\nretry: X — finish the failed work', /line 8: misplaced retry/],
  ['conflicting header grants', 'advice: mechanical\ncontinue: X — finish the work\nretry: Y — repeat failed work\n\nEdit source.', /continue and retry cannot both be present/],
];
for (const taskFile of [false, true]) {
  const channel = taskFile ? 'task file' : 'stdin';
  for (const [name, text, reason] of malformedHeaders) {
    test(`build refuses ${name} from ${channel} before any probe or run folder`, () => {
      const tree = fixture();
      const output = launch(tree, 'codex-build', text, { refuse: true, taskFile, raw: true });
      assertFree(tree, output, 2);
      assert.match(output.stderr, reason);
      if (taskFile) assert.ok(output.stderr.startsWith(`run-codex: ${path.join(tree.root, 'task.md')}: line `));
    });
  }
  test(`a header-only ${channel} is refused as an empty task`, () => {
    const tree = fixture();
    const output = launch(tree, 'codex-build', 'advice: mechanical\n\n', { refuse: true, taskFile, raw: true });
    assert.equal(output.status, 2, output.stderr || output.error?.message);
    assert.match(output.stderr, taskFile ? /task file from --task-file is empty/ : /task text on stdin is empty/);
    assert.equal(output.stdout, '');
    assert.equal(fs.existsSync(tree.runs), false);
  });
}

// Plan_75 D5: transport must retain metadata while extracting only the body sections.
for (const taskFile of [false, true]) {
  test(`settleTaskInput retains either header grant through ${taskFile ? 'task file' : 'stdin'} sections`, () => {
    const tree = fixture();
    for (const kind of ['continue', 'retry']) {
      for (const grantFirst of [false, true]) {
        const lines = ['advice: mechanical', `${kind}: X — finish the work`];
        if (grantFirst) lines.reverse();
        const text = [`repository: ${tree.repo}`, 'order id: advice-fixture', ...lines, '', '## Task', 'Edit source.', '## Questions', '- Inspect source?', '## Verify', 'npm test'].join('\n');
        const opts = { agent: 'codex-review' };
        if (taskFile) {
          opts['task-file'] = path.join(tree.root, 'task.md');
          fs.writeFileSync(opts['task-file'], text);
        }
        const source = `
import { settleTaskInput } from ${JSON.stringify(new URL('../../src/home/lib/runner/task-input.mjs', import.meta.url).href)};
const opts = ${JSON.stringify(opts)};
const input = settleTaskInput(opts);
process.stdout.write(JSON.stringify({ input, questions: opts.questions, verify: opts.verify, continued: opts.continue, orderId: opts.orderId }));
`;
        // raw argv: isolate stdin/file settlement without a launcher or paid process.
        const output = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
          input: taskFile ? '' : text, encoding: 'utf8', timeout: 10_000, windowsHide: true,
        });
        assert.equal(output.status, 0, output.stderr || output.error?.message);
        const result = JSON.parse(output.stdout);
        assert.equal(result.input.task, 'Edit source.');
        assert.equal(result.continued, true);
        assert.equal(result.orderId, 'advice-fixture');
        assert.equal(result.input.header.advice, 'mechanical');
        assert.deepEqual(result.input.header.grant, { kind, run: 'X', reason: 'finish the work' });
        assert.deepEqual(result.input.header.problems, []);
        assert.deepEqual(result.questions, ['Inspect source?']);
        assert.equal(result.verify, 'npm test');
      }
    }
  });
}
