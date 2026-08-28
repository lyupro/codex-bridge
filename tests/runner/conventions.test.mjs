/** Verifies that convention layers are substituted into the task artifact exactly once. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { renderConventions } from '../../src/home/lib/runner/conventions.mjs';

function fixture(t) {
  const root = makeTempTree('bridge-conventions-');
  t.after(() => removeTempTree(root));
  return {
    root,
    repo: path.join(root, 'repo'),
    hostFile: path.join(root, 'conventions.md'),
  };
}

// Mirrors how launcher.mjs assembles task.md: sections start empty on every launch, which is why
// the section cannot be duplicated and no guard pretends to prevent it.
function taskFile(taskText, repoRoot, hostFile) {
  const sections = [`## Operator task (verbatim)\n\n${taskText}`];
  const conventions = renderConventions(repoRoot, hostFile);
  if (conventions) sections.push(conventions);
  sections.push('## Instructions for Codex\n\nTest instructions.');
  return `${sections.join('\n\n')}\n`;
}

test('task.md contains both convention layers when both files exist', (t) => {
  const { root, repo, hostFile } = fixture(t);
  fs.mkdirSync(repo);
  const hostText = 'Host boundary: keep the requested branch.\n';
  const repositoryText = 'Repository rule: keep the fixture small.\n';
  fs.writeFileSync(hostFile, hostText);
  fs.writeFileSync(path.join(repo, '.codex-conventions.md'), repositoryText);

  const task = taskFile('Do the requested work.', repo, hostFile);
  const taskPath = path.join(root, 'both', 'task.md');
  fs.mkdirSync(path.dirname(taskPath));
  fs.writeFileSync(taskPath, task);

  assert.equal(fs.readFileSync(taskPath, 'utf8'), task);
  assert.match(task, /## Conventions/);
  assert.match(task, /### Host conventions/);
  assert.match(task, /### Repository conventions/);
  assert.ok(task.includes(hostText));
  assert.ok(task.includes(repositoryText));
});

test('task.md contains only the host layer when the repository file is absent', (t) => {
  const { repo, hostFile } = fixture(t);
  const hostText = 'Host-only convention.\n';
  fs.writeFileSync(hostFile, hostText);

  const task = taskFile('Host-only task.', repo, hostFile);
  assert.match(task, /## Conventions/);
  assert.match(task, /### Host conventions/);
  assert.doesNotMatch(task, /### Repository conventions/);
  assert.ok(task.includes(hostText));
});

test('task.md contains only the repository layer when the host file is absent', (t) => {
  const { repo, hostFile } = fixture(t);
  const repositoryText = 'Repository-only convention.\n';
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, '.codex-conventions.md'), repositoryText);

  const task = taskFile('Repository-only task.', repo, hostFile);
  assert.match(task, /## Conventions/);
  assert.doesNotMatch(task, /### Host conventions/);
  assert.match(task, /### Repository conventions/);
  assert.ok(task.includes(repositoryText));
});

test('task.md has no conventions section when neither layer exists', (t) => {
  const { repo, hostFile } = fixture(t);
  const task = taskFile('No conventions task.', repo, hostFile);

  assert.doesNotMatch(task, /## Conventions/);
  assert.equal(renderConventions(repo, hostFile), '');
});

test('conventions text is not trimmed or truncated in task.md', (t) => {
  const { root, repo, hostFile } = fixture(t);
  const hostText = `\n${'long-rule-'.repeat(600)}END-OF-CONVENTIONS\n`;
  fs.writeFileSync(hostFile, hostText);
  const taskPath = path.join(root, 'verbatim', 'task.md');
  fs.mkdirSync(path.dirname(taskPath));
  fs.writeFileSync(taskPath, taskFile('Verbatim task.', repo, hostFile));

  const task = fs.readFileSync(taskPath, 'utf8');
  assert.ok(task.includes(hostText));
  assert.ok(task.endsWith('Test instructions.\n'));
});

// Every launch builds its sections from scratch into a folder that is never reused, so a second
// run — a continuation included — carries exactly one section without anything guarding it.
test('each run carries exactly one conventions section', (t) => {
  const { repo, hostFile } = fixture(t);
  const hostText = 'One substituted contract.\n';
  fs.writeFileSync(hostFile, hostText);

  for (const text of ['Initial task.', 'Continue the earlier run.']) {
    const task = taskFile(text, repo, hostFile);
    assert.equal(task.match(/## Conventions/g)?.length, 1, text);
    assert.equal(task.match(new RegExp(hostText.trim(), 'g'))?.length, 1, text);
  }
});

// A guard that looked for this heading in the operator's task text would find it in any task
// that talks ABOUT conventions and drop the section from the one run that most needs it. The
// task text must not be able to switch the mechanism off.
test('a task quoting the section heading still receives the conventions', (t) => {
  const { repo, hostFile } = fixture(t);
  fs.writeFileSync(hostFile, 'Host rule that must reach the run.\n');

  const task = taskFile('Document the ## Conventions section in README.', repo, hostFile);

  assert.equal(task.match(/## Conventions/g)?.length, 2, 'the quote and the real section');
  assert.match(task, /Host rule that must reach the run\./);
});

// doctor warns about an empty rules file because it looks like a working mechanism. In the task
// artifact an empty heading would look worse: rules that were handed over and disregarded.
test('a blank conventions file produces no section at all', (t) => {
  const { repo, hostFile } = fixture(t);
  fs.mkdirSync(repo);
  fs.writeFileSync(hostFile, ' \n\t\n');
  fs.writeFileSync(path.join(repo, '.codex-conventions.md'), '');

  assert.equal(renderConventions(repo, hostFile), '');
  assert.doesNotMatch(taskFile('Blank layers task.', repo, hostFile), /## Conventions/);
});
