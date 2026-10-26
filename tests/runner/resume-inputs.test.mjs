import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { withTempTree } from '../temp-tree.mjs';
import { readResumeInputs } from '../../src/home/lib/runner/resume-inputs.mjs';

const profile = {
  model: 'archived-model-not-in-any-current-config', effort: 'high', speed: 'standard',
  sources: { model: 'order', effort: 'config', speed: 'default' },
};
const task = '# Frozen operator task\r\n\r\nKeep conventions and scope: café, задача.\r\n';
const schema = '\ufeff{\r\n  "type" : "object", "properties": {}\r\n}\r\n';
const advisorTask = '{\r\n "questions": [], "scope": {"run":"old-scope","missing_paths":[]}\r\n}\r\n';
const questions = '\ufeff[\r\n { "id": "Q1", "text": "Frozen question?" }\r\n]\r\n';
const scope = 'Frozen scope\r\ngit diff old-base\r\nsrc/frozen.mjs\r\n';

function write(runDir, name, text) {
  fs.writeFileSync(path.join(runDir, name), text);
}

function writeJson(runDir, name, value) {
  write(runDir, name, JSON.stringify(value));
}

function fixture(root, overrides = {}) {
  const runDir = path.join(root, 'failed-run');
  fs.mkdirSync(runDir);
  const status = {
    agent: 'codex-advisor', phase: 'advise', slug: 'frozen-slug', order_id: 'frozen-order',
    repo: 'C:/frozen/repo', task_hash: 'frozen-hash', task_hash_scheme: 'recorded-scheme',
    continued_from: 'earlier-run', retry_of: 'failed-sibling', ...overrides,
  };
  writeJson(runDir, 'status.json', status);
  writeJson(runDir, 'worker.json', { profile, agent: status.agent });
  write(runDir, 'events.jsonl', `${JSON.stringify({ type: 'thread.started', thread_id: 'frozen-thread' })}\n`);
  writeJson(runDir, 'meta.json', { session_id: 'frozen-thread' });
  write(runDir, 'task.md', task);
  write(runDir, 'schema.json', schema);
  if (status.agent === 'codex-advisor' && status.phase === 'advise') write(runDir, 'advisor-task.json', advisorTask);
  if (status.agent === 'codex-scout') write(runDir, 'questions.json', questions);
  if (status.agent === 'codex-review') write(runDir, 'scope.txt', scope);
  return { runDir, status };
}

function expectReasons(runDir, reasons) {
  assert.deepEqual(readResumeInputs(runDir), { ok: false, reasons });
}

function snapshot(root) {
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory()
      ? [entry.name, snapshot(file)]
      : [entry.name, fs.readFileSync(file).toString('hex'), fs.statSync(file).mtimeMs];
  });
}

test('worker repository accepts platform-equivalent case and separators', async () => {
  await withTempTree('resume-inputs-', (root) => {
    const { runDir } = fixture(root);
    const repo = process.platform === 'win32' ? 'c:\\FROZEN\\REPO\\' : 'C:/frozen/repo/';
    writeJson(runDir, 'worker.json', { profile, repo });
    assert.equal(readResumeInputs(runDir).ok, true);
  });
});

test('worker repository differing from status refuses frozen replay', async () => {
  await withTempTree('resume-inputs-', (root) => {
    const { runDir } = fixture(root);
    writeJson(runDir, 'worker.json', { profile, repo: 'C:/another/repo' });
    expectReasons(runDir, ['repo-mismatch']);
  });
});

for (const repo of [undefined, '', '   ']) {
  test(`worker without a non-empty repository adds no reason (${String(repo)})`, async () => {
    await withTempTree('resume-inputs-', (root) => {
      const { runDir } = fixture(root);
      writeJson(runDir, 'worker.json', { profile, repo });
      assert.equal(readResumeInputs(runDir).ok, true);
    });
  });
}

// Plan_80 E13/O3: replay includes the frozen prompt and scope, never today's reconstructed order.
test('complete advisor advise run returns every frozen field and exact original bytes', async () => {
  await withTempTree('resume-inputs-', (root) => {
    const { runDir, status } = fixture(root);
    assert.deepEqual(readResumeInputs(runDir), {
      ok: true,
      inputs: {
        agent: status.agent, phase: status.phase, slug: status.slug, order_id: status.order_id,
        repo: status.repo, task_hash: status.task_hash, task_hash_scheme: status.task_hash_scheme,
        continued_from: status.continued_from, profile, thread_id: 'frozen-thread',
        files: { 'task-original.md': task, 'schema.json': schema, 'advisor-task.json': advisorTask },
      },
    });
  });
});

for (const [agent, name, raw] of [
  ['codex-scout', 'questions.json', questions], ['codex-review', 'scope.txt', scope],
]) {
  test(`${agent} includes its exact role artifact and no advisor artifact`, async () => {
    await withTempTree('resume-inputs-', (root) => {
      const { runDir } = fixture(root, { agent, phase: 'review' });
      const result = readResumeInputs(runDir);
      assert.equal(result.ok, true);
      assert.deepEqual(result.inputs.files, { 'task-original.md': task, 'schema.json': schema, [name]: raw });
    });
  });
}

test('resume of a resume uses task-original.md instead of the short task.md', async () => {
  await withTempTree('resume-inputs-', (root) => {
    const { runDir } = fixture(root);
    write(runDir, 'task-original.md', task);
    write(runDir, 'task.md', 'Resume the existing thread.\n');
    assert.equal(readResumeInputs(runDir).inputs.files['task-original.md'], task);
    fs.unlinkSync(path.join(runDir, 'task.md'));
    assert.equal(readResumeInputs(runDir).inputs.files['task-original.md'], task);
  });
});

test('optional status fields are not required and absent continued_from becomes null', async () => {
  await withTempTree('resume-inputs-', (root) => {
    const { runDir, status } = fixture(root);
    for (const key of ['slug', 'task_hash_scheme', 'continued_from']) delete status[key];
    writeJson(runDir, 'status.json', status);
    const result = readResumeInputs(runDir);
    assert.equal(result.ok, true);
    assert.equal(result.inputs.continued_from, null);
    assert.equal(result.inputs.slug, undefined);
    assert.equal(result.inputs.task_hash_scheme, undefined);
  });
});

for (const content of [undefined, '{broken']) {
  test(`status-unreadable stops all other checks (${content === undefined ? 'missing' : 'invalid JSON'})`, async () => {
    await withTempTree('resume-inputs-', (root) => {
      if (content !== undefined) write(root, 'status.json', content);
      expectReasons(root, ['status-unreadable']);
    });
  });
}

for (const key of ['agent', 'order_id', 'phase', 'repo', 'task_hash']) {
  for (const value of [undefined, '', '   ']) {
    test(`status-incomplete alone for ${key} = ${String(value)}`, async () => {
      await withTempTree('resume-inputs-', (root) => {
        const { runDir } = fixture(root, { [key]: value });
        expectReasons(runDir, ['status-incomplete']);
      });
    });
  }
}

for (const value of [null, [], 'invalid-status']) {
  test(`valid JSON without status fields is incomplete (${JSON.stringify(value)})`, async () => {
    await withTempTree('resume-inputs-', (root) => {
      const { runDir } = fixture(root);
      writeJson(runDir, 'status.json', value);
      expectReasons(runDir, ['status-incomplete']);
    });
  });
}

for (const content of [undefined, '{broken']) {
  test(`worker-order-unreadable alone (${content === undefined ? 'missing' : 'invalid JSON'})`, async () => {
    await withTempTree('resume-inputs-', (root) => {
      const { runDir } = fixture(root);
      if (content === undefined) fs.unlinkSync(path.join(runDir, 'worker.json'));
      else write(runDir, 'worker.json', content);
      expectReasons(runDir, ['worker-order-unreadable']);
    });
  });
}

for (const value of [undefined, null, [], 'model', 1, false]) {
  test(`profile-missing alone for non-object profile ${JSON.stringify(value)}`, async () => {
    await withTempTree('resume-inputs-', (root) => {
      const { runDir } = fixture(root);
      writeJson(runDir, 'worker.json', { profile: value });
      expectReasons(runDir, ['profile-missing']);
    });
  });
}

for (const content of [undefined, '', '{broken\n', '{"type":"thread.started","thread_id":""}\n']) {
  test(`thread-unavailable alone for missing or unusable events ${JSON.stringify(content)}`, async () => {
    await withTempTree('resume-inputs-', (root) => {
      const { runDir } = fixture(root);
      if (content === undefined) fs.unlinkSync(path.join(runDir, 'events.jsonl'));
      else write(runDir, 'events.jsonl', content);
      fs.unlinkSync(path.join(runDir, 'meta.json'));
      expectReasons(runDir, ['thread-unavailable']);
    });
  });
}

test('thread-mismatch alone when meta and events identify different threads', async () => {
  await withTempTree('resume-inputs-', (root) => {
    const { runDir } = fixture(root);
    writeJson(runDir, 'meta.json', { session_id: 'another-thread' });
    expectReasons(runDir, ['thread-mismatch']);
  });
});

for (const content of [undefined, '{broken', '{}', '{"session_id":""}', 'null']) {
  test(`optional metadata does not block replay when it supplies no thread ${String(content)}`, async () => {
    await withTempTree('resume-inputs-', (root) => {
      const { runDir } = fixture(root);
      if (content === undefined) fs.unlinkSync(path.join(runDir, 'meta.json'));
      else write(runDir, 'meta.json', content);
      assert.equal(readResumeInputs(runDir).ok, true);
    });
  });
}

for (const [agent, name] of [
  ['codex-advisor', 'task.md'], ['codex-advisor', 'schema.json'],
  ['codex-advisor', 'advisor-task.json'], ['codex-scout', 'questions.json'], ['codex-review', 'scope.txt'],
]) {
  test(`artifact-missing:${name} alone`, async () => {
    await withTempTree('resume-inputs-', (root) => {
      const { runDir } = fixture(root, { agent });
      fs.unlinkSync(path.join(runDir, name));
      expectReasons(runDir, [`artifact-missing:${name}`]);
    });
  });
}

for (const [agent, name, content] of [
  ['codex-advisor', 'schema.json', '{broken'],
  ['codex-scout', 'questions.json', '{broken'],
  ['codex-scout', 'questions.json', '{}'],
  ['codex-scout', 'questions.json', 'null'],
  ['codex-advisor', 'advisor-task.json', '{broken'],
  ['codex-advisor', 'advisor-task.json', '[]'],
  ['codex-advisor', 'advisor-task.json', 'null'],
  ['codex-advisor', 'advisor-task.json', '"text"'],
]) {
  test(`artifact-malformed:${name} alone for ${content}`, async () => {
    await withTempTree('resume-inputs-', (root) => {
      const { runDir } = fixture(root, { agent });
      write(runDir, name, content);
      expectReasons(runDir, [`artifact-malformed:${name}`]);
    });
  });
}

// Plan_80 E13/O3 fixes this order so callers receive all applicable diagnostics deterministically.
for (const worker of ['{broken', '{}']) {
  test(`all applicable reasons retain the fixed order with worker ${worker}`, async () => {
    await withTempTree('resume-inputs-', (root) => {
      const { runDir } = fixture(root, { order_id: '' });
      write(runDir, 'worker.json', worker);
      write(runDir, 'events.jsonl', '');
      fs.unlinkSync(path.join(runDir, 'task.md'));
      write(runDir, 'schema.json', '{broken');
      fs.unlinkSync(path.join(runDir, 'advisor-task.json'));
      expectReasons(runDir, [
        'status-incomplete', worker === '{}' ? 'profile-missing' : 'worker-order-unreadable',
        'thread-unavailable', 'thread-mismatch', 'artifact-missing:task.md',
        'artifact-malformed:schema.json', 'artifact-missing:advisor-task.json',
      ]);
    });
  });
}

test('BOM JSON boundaries, truncated events and current configuration preserve the recorded profile', async () => {
  await withTempTree('resume-inputs-', (root) => {
    const { runDir, status } = fixture(root);
    write(runDir, 'status.json', `\ufeff${JSON.stringify(status)}`);
    write(runDir, 'worker.json', `\ufeff${JSON.stringify({ profile })}`);
    write(runDir, 'meta.json', '\ufeff{"session_id":"frozen-thread"}');
    write(runDir, 'advisor-task.json', `\ufeff${advisorTask}`);
    fs.appendFileSync(path.join(runDir, 'events.jsonl'), '{"type":');
    const configDir = path.join(root, 'src', 'home');
    fs.mkdirSync(configDir, { recursive: true });
    writeJson(configDir, 'config.json', { model: 'today-model', effort: 'low' });
    const before = readResumeInputs(runDir);
    writeJson(configDir, 'config.json', { model: 'tomorrow-model', effort: 'medium' });
    const after = readResumeInputs(runDir);
    assert.equal(after.ok, true);
    assert.deepEqual(after.inputs.profile, profile);
    assert.deepEqual(after, before);
    assert.equal(after.inputs.files['advisor-task.json'], `\ufeff${advisorTask}`);
  });
});

test('advisor scope phase requires no advise artifact', async () => {
  await withTempTree('resume-inputs-', (root) => {
    const { runDir } = fixture(root, { phase: 'scope' });
    assert.deepEqual(Object.keys(readResumeInputs(runDir).inputs.files), ['task-original.md', 'schema.json']);
  });
});

test('reader creates and writes nothing on success or failure, including a missing directory', async () => {
  await withTempTree('resume-inputs-', (root) => {
    const { runDir } = fixture(root);
    const before = snapshot(root);
    assert.equal(readResumeInputs(runDir).ok, true);
    assert.deepEqual(snapshot(root), before);
    write(runDir, 'schema.json', '{broken');
    const broken = snapshot(root);
    expectReasons(runDir, ['artifact-malformed:schema.json']);
    expectReasons(path.join(root, 'not-created'), ['status-unreadable']);
    assert.deepEqual(snapshot(root), broken);
  });
});
