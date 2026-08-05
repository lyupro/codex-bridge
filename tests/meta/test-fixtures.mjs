/**
 * Builds the on-disk artifacts of a temporary codex run, for tests that read real files
 * rather than mocked ones: makeRun() writes a single run directory the way collect() reads
 * it; makeChainRoot() writes one or more passes of a task into a fresh runs root, the way
 * chainRuns()/chainBaseline() and reportVersusWork() read them. Shared because more than
 * one test file needs the same fixture; if a helper is only ever used by one test file it
 * stays defined in that file instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Diagnostic text retained as an input for archived-run compatibility cases. */
export const OK_LOG = 'model: gpt-5.6-sol\nsandbox: workspace-write\ntokens used\n104 098\n';

/** A build result that satisfies the schema, so a test can vary only what it is about. */
export const buildResult = (changes, extra = {}) => ({
  // Declared, because the schema requires it of every run from 0.1.3 on. Runs whose fixture
  // writes no schema.json are archived runs and ignore it — see meta/outcome.mjs.
  outcome: 'done',
  summary: 'done',
  changes,
  verify_command: 'npm test',
  verify_passed: true,
  leftovers: [],
  report_markdown: '# report',
  ...extra,
});

// One task, addressed the way run-codex.mjs writes it into status.json.
export const CHAIN_REPO = '/repo/task';
export const CHAIN_SLUG = 'plan6-b1';

/** A run directory on disk, because collect() deliberately reads artifacts, not arguments. */
export function makeRun({
  log = OK_LOG,
  stderr,
  result,
  before = '',
  after = '',
  file = 'result.json',
  questions,
  // The response contract this run ran under, written the way the launcher writes it. Absent
  // means an archived run: one from before the contract carried an outcome field.
  schema,
  scope,
  envPaths,
  headBefore,
  headAfter,
  branchBefore,
  branchAfter,
  status,
  events,
  args,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-run-'));
  const writesDiagnostic = stderr === undefined && log !== OK_LOG;
  const quotaEvent = writesDiagnostic && args === undefined && /rate.?limit|quota|429/i.test(log)
    ? { type: 'error', message: log.trim() }
    : null;
  if (stderr !== undefined || events !== undefined || writesDiagnostic) {
    fs.writeFileSync(path.join(dir, 'stderr.log'), stderr ?? (writesDiagnostic ? log : ''));
  }
  if (events !== undefined) {
    const jsonl = events === null
      ? null
      : Array.isArray(events)
      ? events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '')
      : String(events);
    if (jsonl !== null) fs.writeFileSync(path.join(dir, 'events.jsonl'), jsonl);
  } else if (quotaEvent) {
    fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(quotaEvent)}\n`);
  }
  if (args !== undefined) fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({ args }));
  if (status !== undefined) fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status));
  if (result !== undefined) fs.writeFileSync(path.join(dir, file), JSON.stringify(result));
  fs.writeFileSync(path.join(dir, 'state-before.txt'), before);
  fs.writeFileSync(path.join(dir, 'state-after.txt'), after);
  if (questions !== undefined) fs.writeFileSync(path.join(dir, 'questions.json'), JSON.stringify(questions));
  if (schema !== undefined) fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(schema));
  if (scope !== undefined) fs.writeFileSync(path.join(dir, 'scope.txt'), scope);
  if (envPaths !== undefined) {
    fs.writeFileSync(
      path.join(dir, 'env.json'),
      JSON.stringify({ hooks: false, plugins: false, environmentPaths: envPaths }),
    );
  }
  if (headBefore !== undefined) fs.writeFileSync(path.join(dir, 'head-before.txt'), headBefore);
  if (headAfter !== undefined) fs.writeFileSync(path.join(dir, 'head-after.txt'), headAfter);
  if (branchBefore !== undefined) fs.writeFileSync(path.join(dir, 'branch-before.txt'), branchBefore);
  if (branchAfter !== undefined) fs.writeFileSync(path.join(dir, 'branch-after.txt'), branchAfter);
  return dir;
}

/**
 * A runs root holding several passes of one task, which is what chainRuns() reads off disk.
 * Each entry is one pass: `at` decides the order, `repo`/`slug` override the task it belongs
 * to, `state` overrides how the pass ended (`abandoned` is what a killed runner leaves),
 * `status: null` is a folder from before status.json existed, and an absent `before` or
 * `after` is a pass that was killed before it could snapshot the tree.
 */
export function makeChainRoot(runs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  for (const run of runs) {
    const dir = path.join(root, run.name);
    fs.mkdirSync(dir);
    if (run.status !== null) {
      const status = {
        state: run.state ?? 'finished',
        agent: 'codex-build',
        repo: run.repo ?? CHAIN_REPO,
        slug: run.slug ?? CHAIN_SLUG,
        started_at: run.at ?? '',
        ...(run.taskHash === undefined ? {} : { task_hash: run.taskHash }),
        ...(run.orderId === undefined ? {} : { order_id: run.orderId }),
      };
      fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status));
    }
    if (run.envPaths !== undefined) {
      fs.writeFileSync(
        path.join(dir, 'env.json'),
        JSON.stringify({ hooks: false, plugins: false, environmentPaths: run.envPaths }),
      );
    }
    if (run.before !== undefined) fs.writeFileSync(path.join(dir, 'state-before.txt'), run.before);
    if (run.after !== undefined) fs.writeFileSync(path.join(dir, 'state-after.txt'), run.after);
    if (run.branchBefore !== undefined) fs.writeFileSync(path.join(dir, 'branch-before.txt'), run.branchBefore);
    if (run.result !== undefined) {
      fs.writeFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'thread.started', thread_id: 'fixture' })}\n`);
      fs.writeFileSync(path.join(dir, 'stderr.log'), '');
      fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(run.result));
    }
  }
  return root;
}
