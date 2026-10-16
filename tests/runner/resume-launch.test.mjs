/** Plan_80 E13/O6: frozen resume artifacts and worker orders. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { before, mock } from 'node:test';
import { withTempTree } from '../temp-tree.mjs';
import { readResumeInputs } from '../../src/home/lib/runner/resume-inputs.mjs';
import { resumeArgs } from '../../src/home/lib/runner/codex-args.mjs';
import { resumePrompt } from '../../src/home/lib/runner/prompts.mjs';
import { loadRunEnv, RUN_ENV } from '../../src/home/lib/runner/run-env.mjs';
import { CONFIG_PATH } from '../../src/home/lib/run-config.mjs';
import {
  resumeSituationKind, writeResumeArtifacts, resumeWorkerFields,
} from '../../src/home/lib/runner/resume-launch.mjs';

const THREAD_ID = '12345678-1234-1234-1234-123456789abc';
const KIND = 'recent-activity';
const NOTE = '  Continue the stopped pass \u2014 caf\u00e9 and \u65e5\u672c\u8a9e.  \n\nKeep this note for the record.\n';
const PROFILE = {
  model: 'frozen-model-not-in-configuration', model_source: 'config',
  effort: 'high', effort_source: 'request', speed: 'fast', speed_source: 'config',
};

before(() => {
  // The launcher loads CLEAN_ENV before building argv; isolate that step from host config.
  const readFileSync = fs.readFileSync;
  const configRead = mock.method(fs, 'readFileSync', (file, ...args) =>
    file === CONFIG_PATH ? '{}' : readFileSync(file, ...args));
  try {
    loadRunEnv();
  } finally {
    configRead.mock.restore();
  }
  assert.equal(Object.values(RUN_ENV.models ?? {}).some(({ model }) => model === PROFILE.model), false);
});

function recordRun(runDir, agent, phase) {
  const status = {
    agent, phase, order_id: 'ow066-resume-launch', repo: path.dirname(runDir),
    task_hash: 'frozen-task-hash',
  };
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(status), 'utf8');
  fs.writeFileSync(path.join(runDir, 'worker.json'), JSON.stringify({ profile: PROFILE }), 'utf8');
  fs.writeFileSync(path.join(runDir, 'events.jsonl'),
    JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID }) + '\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'meta.json'),
    JSON.stringify({ session_id: THREAD_ID, situation: { kind: KIND } }), 'utf8');
}

function namedRun(root, agent, phase) {
  const runDir = path.join(root, 'named');
  fs.mkdirSync(runDir);
  recordRun(runDir, agent, phase);
  const files = {
    'task.md': '# Original task\n\nPreserve whitespace, café, and 日本語.  \n',
    'schema.json': '{\r\n  "type" : "object", "properties": {}\r\n}\r\n',
  };
  if (agent === 'codex-advisor' && phase === 'advise') {
    files['advisor-task.json'] = '{ "question" : "frozen design", "options" : [] }\n';
  }
  if (agent === 'codex-scout') files['questions.json'] = '[  { "id" : "Q1" }  ]\n';
  if (agent === 'codex-review') files['scope.txt'] = 'src/example.mjs\nspace in name.mjs\n';
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(runDir, name), text, 'utf8');
  }
  return runDir;
}

function inputsOf(runDir) {
  const result = readResumeInputs(runDir);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.inputs;
}

function emptyRun(root, name = 'resume') {
  const runDir = path.join(root, name);
  fs.mkdirSync(runDir);
  return runDir;
}

for (const [agent, phase, extra] of [
  ['codex-advisor', 'advise', 'advisor-task.json'],
  ['codex-scout', 'scout', 'questions.json'],
  ['codex-review', 'review', 'scope.txt'],
]) {
  test(agent + ' copies frozen artifacts and note byte for byte, with only the continuation prompt in task.md', async () => {
    await withTempTree('resume-launch-', (root) => {
      const named = namedRun(root, agent, phase);
      const inputs = inputsOf(named);
      const runDir = emptyRun(root);
      const situationKind = resumeSituationKind(named);
      writeResumeArtifacts({ runDir, inputs, situationKind, note: NOTE });
      assert.deepEqual(fs.readdirSync(runDir).sort(),
        ['task-original.md', 'schema.json', extra, 'task.md', 'resume-note.md'].sort());
      for (const name of ['task-original.md', 'schema.json', extra]) {
        const source = name === 'task-original.md' ? 'task.md' : name;
        assert.deepEqual(fs.readFileSync(path.join(runDir, name)),
          fs.readFileSync(path.join(named, source)));
      }
      assert.equal(fs.readFileSync(path.join(runDir, 'task.md'), 'utf8'), resumePrompt(KIND));
      assert.deepEqual(fs.readFileSync(path.join(runDir, 'resume-note.md')), Buffer.from(NOTE, 'utf8'));
      assert.equal(fs.readFileSync(path.join(runDir, 'task.md'), 'utf8').includes(NOTE), false);
      assert.notEqual(fs.readFileSync(path.join(runDir, 'task.md'), 'utf8'), inputs.files['task-original.md']);
      assert.deepEqual(fs.readdirSync(root).sort(), ['named', 'resume']);
    });
  });
}

test('a resume of a resume preserves task-original.md instead of the short task.md', async () => {
  await withTempTree('resume-launch-chain-', (root) => {
    const named = namedRun(root, 'codex-advisor', 'advise');
    const first = emptyRun(root, 'first-resume');
    writeResumeArtifacts({ runDir: first, inputs: inputsOf(named), situationKind: KIND, note: NOTE });
    recordRun(first, 'codex-advisor', 'advise');
    const second = emptyRun(root, 'second-resume');
    const secondNote = 'A separate note for the second resume.\n';
    writeResumeArtifacts({ runDir: second, inputs: inputsOf(first), situationKind: KIND, note: secondNote });
    assert.equal(fs.readFileSync(path.join(second, 'resume-note.md'), 'utf8'), secondNote);
    assert.deepEqual(fs.readFileSync(path.join(second, 'task-original.md')),
      fs.readFileSync(path.join(named, 'task.md')));
    assert.notDeepEqual(fs.readFileSync(path.join(second, 'task-original.md')),
      fs.readFileSync(path.join(first, 'task.md')));
  });
});

test('resumeSituationKind reads the recorded kind through the BOM-aware JSON reader', async () => {
  await withTempTree('resume-launch-kind-', (root) => {
    const named = namedRun(root, 'codex-advisor', 'advise');
    assert.equal(resumeSituationKind(named), KIND);
    fs.writeFileSync(path.join(named, 'meta.json'),
      '\ufeff{"situation":{"kind":"silent-stall-candidate"}}\n', 'utf8');
    assert.equal(resumeSituationKind(named), 'silent-stall-candidate');
  });
});

for (const [name, contents] of [
  ['missing meta.json', undefined],
  ['missing situation', '{}'],
  ['invalid kind', '{"situation":{"kind":"Bad Kind"}}'],
  ['non-string kind', '{"situation":{"kind":42}}'],
  ['null metadata', 'null'],
  ['malformed metadata', '{'],
]) {
  test('resumeSituationKind returns evidence-unknown for ' + name, async () => {
    await withTempTree('resume-launch-unknown-', (root) => {
      if (contents !== undefined) fs.writeFileSync(path.join(root, 'meta.json'), contents, 'utf8');
      assert.equal(resumeSituationKind(root), 'evidence-unknown');
    });
  });
}

test('resumeSituationKind never throws when meta.json is unreadable as a file', async () => {
  await withTempTree('resume-launch-unreadable-', (root) => {
    fs.mkdirSync(path.join(root, 'meta.json'));
    assert.equal(resumeSituationKind(root), 'evidence-unknown');
    assert.equal(resumeSituationKind(null), 'evidence-unknown');
  });
});

for (const note of [undefined, null, 42, {}, [], '', ' ', '\t\n\r ']) {
  test('rejects invalid note ' + JSON.stringify(note) + ' before writing any artifact', async () => {
    await withTempTree('resume-launch-note-', (root) => {
      const inputs = inputsOf(namedRun(root, 'codex-advisor', 'advise'));
      const runDir = emptyRun(root);
      assert.throws(() => writeResumeArtifacts({ runDir, inputs, situationKind: KIND, note }), TypeError);
      assert.deepEqual(fs.readdirSync(runDir), []);
    });
  });
}

for (const destination of ['unexpected.txt', '../escaped.md', 'nested/scope.txt', 'task.md', 'resume-note.md']) {
  test('rejects destination ' + destination + ' before writing any artifact', async () => {
    await withTempTree('resume-launch-destination-', (root) => {
      const named = namedRun(root, 'codex-advisor', 'advise');
      const inputs = inputsOf(named);
      inputs.files[destination] = 'must not be written';
      const runDir = emptyRun(root);
      assert.throws(() => writeResumeArtifacts({ runDir, inputs, situationKind: KIND, note: NOTE }), TypeError);
      assert.deepEqual(fs.readdirSync(runDir), []);
      assert.deepEqual(fs.readdirSync(root).sort(), ['named', 'resume']);
    });
  });
}

for (const missing of ['schema.json', 'task-original.md']) {
  test('rejects missing ' + missing + ' before writing any artifact', async () => {
    await withTempTree('resume-launch-required-', (root) => {
      const inputs = inputsOf(namedRun(root, 'codex-advisor', 'advise'));
      delete inputs.files[missing];
      const runDir = emptyRun(root);
      assert.throws(() => writeResumeArtifacts({ runDir, inputs, situationKind: KIND, note: NOTE }), TypeError);
      assert.deepEqual(fs.readdirSync(runDir), []);
    });
  });
}

test('invalid situation kind is rejected before writing frozen artifacts', async () => {
  await withTempTree('resume-launch-prompt-', (root) => {
    const inputs = inputsOf(namedRun(root, 'codex-scout', 'scout'));
    const runDir = emptyRun(root);
    assert.throws(() => writeResumeArtifacts({ runDir, inputs, situationKind: 'Bad Kind', note: NOTE }), RangeError);
    assert.deepEqual(fs.readdirSync(runDir), []);
  });
});

for (const [agent, phase, output] of [
  ['codex-advisor', 'advise', 'result.json'],
  ['codex-scout', 'scout', 'result.json'],
  ['codex-review', 'review', 'review.json'],
]) {
  test(agent + ' worker fields use frozen profile and resume argv with ' + output, async () => {
    await withTempTree('resume-launch-worker-', (root) => {
      const named = namedRun(root, agent, phase);
      const inputs = inputsOf(named);
      const runDir = emptyRun(root);
      const fields = resumeWorkerFields({ inputs, runDir, resumedFrom: named });
      assert.deepEqual(Object.keys(fields).sort(), ['args', 'profile', 'resume']);
      assert.deepEqual(fields.args, resumeArgs({ agent, profile: inputs.profile,
        threadId: THREAD_ID, runDir }));
      assert.strictEqual(fields.profile, inputs.profile);
      assert.deepEqual(fields.profile, PROFILE);
      assert.equal(fields.args[fields.args.indexOf('-m') + 1], PROFILE.model);
      assert.equal(fields.args.includes('--sandbox'), false);
      assert.equal(fields.args.includes('-C'), false);
      assert.equal(fields.args.at(-1), '-');
      assert.equal(fields.args[fields.args.indexOf('-o') + 1], path.join(runDir, output));
      assert.deepEqual(fields.resume, {
        thread_id: THREAD_ID, resumed_from: named, sandbox_mode: 'read-only',
      });
      assert.deepEqual(fs.readdirSync(runDir), []);
    });
  });
}
