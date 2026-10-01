/** Guards Plan_65 D12/D14: one ordered purge preflight grants a transaction-bound, single-use capability. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../../cli/install.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { withLifecycle } from '../../cli/lifecycle-transaction.mjs';
import { runPurgePreflight } from '../../cli/purge-preflight.mjs';
import { liveRunLines } from '../../cli/purge-live-runs.mjs';
import { executeHomePlan } from '../../cli/home-plan-execute.mjs';
import { installRecordPath } from '../../cli/install-record.mjs';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const clear = () => ({ verdict: 'clear', blocked: [], unknown: [] });
const authorizationError = /purge requires its preflight authorization/;

async function installedHome(t) {
  const root = makeTempTree('bridge-purge-preflight-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'), codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'home'),
  });
  await install({ host });
  return { root, host };
}

function consent(answers = ['yes', 'yes'], extra = {}) {
  const questions = [];
  const options = { isTTY: true, ...extra, prompt: async (question) => {
    questions.push(question);
    assert.ok(questions.length <= answers.length, 'No unexpected consent question');
    return answers[questions.length - 1];
  } };
  return { options, questions };
}

function preflight(host, ticket, options, liveRunCheck = clear) {
  return runPurgePreflight({ host, ticket, packageRoot, options, liveRunCheck });
}

function execute(host, { plan, authorization }) {
  return executeHomePlan(host, plan, { detached: true, imageMembers: plan.imageMembers, authorization });
}

async function snapshot(root) {
  const entries = [];
  const walk = async (relative) => {
    const target = path.join(root, relative);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) {
      entries.push({ relative, kind: 'link', target: await fs.readlink(target) });
    } else if (stat.isDirectory()) {
      entries.push({ relative, kind: 'directory' });
      for (const name of (await fs.readdir(target)).sort()) {
        await walk(relative ? `${relative}/${name}` : name);
      }
    } else {
      entries.push({ relative, kind: 'file', bytes: await fs.readFile(target) });
    }
  };
  await walk('');
  return entries;
}

test('outside a transaction and forged tickets throw before checking runs or asking consent', async (t) => {
  const { root, host } = await installedHome(t);
  const before = await snapshot(root);
  const { options, questions } = consent();
  const unexpectedCheck = () => assert.fail('Ticket validation must precede the live-run check');
  await assert.rejects(preflight(host, undefined, options, unexpectedCheck), /lifecycle ticket/);
  await withLifecycle(host, 'purge-test', async () => {
    await assert.rejects(preflight(host, {}, options, unexpectedCheck), /lifecycle ticket/);
  });
  assert.equal(questions.length, 0);
  assert.deepEqual(await snapshot(root), before);
});

for (const verdict of ['blocked', 'unknown']) {
  test(`${verdict} runs refuse before the corrupt record and consent, without changing disk`, async (t) => {
    const { root, host } = await installedHome(t);
    await fs.writeFile(installRecordPath(host), '{');
    const before = await snapshot(root);
    const { options, questions } = consent();
    const result = verdict === 'blocked'
      ? { verdict, blocked: [{ runDir: 'live', stop: 'stop live' }], unknown: [] }
      : { verdict, blocked: [], unknown: [{ path: 'runs', reason: 'EACCES' }] };
    let checks = 0;
    const outcome = await withLifecycle(host, 'purge-test', (ticket) => preflight(host, ticket, options, () => {
      checks += 1;
      return result;
    }));
    assert.deepEqual(outcome, { verdict: 'refused', lines: liveRunLines(result) });
    assert.equal(checks, 1);
    assert.equal(questions.length, 0);
    assert.deepEqual(await snapshot(root), before);
  });
}

test('a corrupt installation record refuses without asking consent or changing disk', async (t) => {
  const { root, host } = await installedHome(t);
  await fs.writeFile(installRecordPath(host), '{');
  const before = await snapshot(root);
  const { options, questions } = consent();
  const outcome = await withLifecycle(host, 'purge-test', (ticket) => preflight(host, ticket, options));
  assert.deepEqual(outcome, { verdict: 'refused', lines: [
    `The installation record of ${host.brandRoot} is unreadable: purge cannot tell who uses this home.`,
  ] });
  assert.equal(questions.length, 0);
  assert.deepEqual(await snapshot(root), before);
});

test('every other recorded owner refuses even when the prompt would answer yes', async (t) => {
  const { root, host } = await installedHome(t);
  const otherRoots = [];
  for (const name of ['other-host', 'third-host']) {
    const other = resolveHost({
      host: path.join(root, name), codexHome: path.join(root, `${name}-codex-home`), brandRoot: host.brandRoot,
    });
    await install({ host: other });
    otherRoots.push(normalizeRepoPath(other.root));
  }
  const before = await snapshot(root);
  const { options, questions } = consent();
  const outcome = await withLifecycle(host, 'purge-test', (ticket) => preflight(host, ticket, options));
  assert.deepEqual(outcome, { verdict: 'refused', lines: otherRoots.map((owner) =>
    `${owner} is recorded as using ${host.brandRoot}; uninstall it first.`) });
  assert.equal(questions.length, 0);
  assert.deepEqual(await snapshot(root), before);
});

const refusals = [
  { name: 'inventory no', answers: ['no'], verdict: 'refused', calls: 1, consentKind: 'inventory' },
  { name: 'inventory cancel', answers: ['cancel'], verdict: 'cancelled', calls: 1 },
  { name: 'data no', answers: ['yes', 'no'], verdict: 'refused', calls: 2, consentKind: 'data' },
  { name: 'data cancel', answers: ['yes', 'cancel'], verdict: 'cancelled', calls: 2 },
  { name: 'no terminal', answers: ['yes', 'yes'], verdict: 'refused', calls: 0, consentKind: 'inventory',
    extra: { isTTY: false } },
];
for (const scenario of refusals) {
  test(`${scenario.name} leaves disk unchanged and asks only the expected questions`, async (t) => {
    const { root, host } = await installedHome(t);
    const before = await snapshot(root);
    const { options, questions } = consent(scenario.answers, scenario.extra);
    const outcome = await withLifecycle(host, 'purge-test', (ticket) => preflight(host, ticket, options));
    const expected = scenario.verdict === 'cancelled' ? { verdict: 'cancelled' } : {
      verdict: 'refused', lines: [scenario.consentKind === 'data'
        ? `Purge needs your consent to delete your data in ${host.brandRoot}.`
        : `Purge needs your confirmation that no other host uses ${host.brandRoot}.`],
    };
    assert.deepEqual(outcome, expected);
    assert.equal(questions.length, scenario.calls);
    if (questions.length) assert.match(questions[0], /Is the inventory complete/);
    if (questions.length === 2) assert.match(questions[1], /Delete it\?/);
    assert.deepEqual(await snapshot(root), before);
  });
}

test('authorized purge lists sorted data, freezes its plan and removes files, record and empty home', async (t) => {
  const { host } = await installedHome(t);
  await fs.mkdir(path.join(host.brandRoot, 'state'), { recursive: true });
  await fs.writeFile(path.join(host.brandRoot, 'state/host-observations.json'), '{}');
  const { options, questions } = consent();
  let checks = 0;
  await withLifecycle(host, 'purge-test', async (ticket) => {
    const granted = await preflight(host, ticket, options, () => { checks += 1; return clear(); });
    assert.equal(granted.verdict, 'authorized');
    const { plan, authorization } = granted;
    assert.equal(plan.homeRoot, 'present');
    assert.deepEqual(Object.keys(authorization), []);
    for (const value of [plan, plan.rows, ...plan.rows, plan.directories, ...plan.directories,
      plan.record, plan.imageMembers, plan.format2, plan.format2.owners]) {
      assert.equal(Object.isFrozen(value), true);
    }
    assert.throws(() => { plan.rows[0].action = 'keep'; }, TypeError);
    const data = questions[1].split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim());
    assert.deepEqual(data, ['config.json', 'conventions.md', 'state/host-observations.json']);
    const { outcomes } = await execute(host, granted);
    for (const relative of [...plan.imageMembers, ...data, '.installed.json', '']) {
      assert.equal(outcomes.find((entry) => entry.relative === relative)?.result, 'removed', relative);
    }
    assert.equal(outcomes.at(-1).relative, '');
    await assert.rejects(execute(host, granted), authorizationError);
    assert.equal(checks, 1, 'The executor must not check live runs again');
    assert.equal(questions.length, 2, 'The executor must not ask consent again');
  });
  await assert.rejects(fs.lstat(host.brandRoot), { code: 'ENOENT' });
});

test('D4 keeps and names files behind a home junction during an authorized purge', async (t) => {
  const { root, host } = await installedHome(t);
  const folder = path.join(host.brandRoot, 'lib/runner');
  const outside = path.join(root, 'outside-runner');
  await fs.rename(folder, outside);
  await fs.symlink(outside, folder, 'junction');
  const before = await snapshot(outside);
  const { options } = consent();
  await withLifecycle(host, 'purge-test', async (ticket) => {
    const granted = await preflight(host, ticket, options);
    assert.equal(granted.verdict, 'authorized');
    const linkedRows = granted.plan.rows.filter((row) => row.relative.startsWith('lib/runner/'));
    assert.ok(linkedRows.length > 0);
    const { outcomes } = await execute(host, granted);
    for (const row of linkedRows) {
      const outcome = outcomes.find((entry) => entry.relative === row.relative);
      assert.equal(outcome.result, 'blocked');
      assert.equal(outcome.reason, 'link at lib/runner');
    }
  });
  assert.deepEqual(await snapshot(outside), before);
  assert.equal((await fs.lstat(folder)).isSymbolicLink(), true);
});

test('an authorization dies with its transaction and is consumed even by the stale attempt', async (t) => {
  const { root, host } = await installedHome(t);
  const { options } = consent();
  const granted = await withLifecycle(host, 'purge-test', (ticket) => preflight(host, ticket, options));
  assert.equal(granted.verdict, 'authorized');
  const before = await snapshot(root);
  await assert.rejects(execute(host, granted), /lifecycle ticket is no longer active/);
  await assert.rejects(execute(host, granted), authorizationError);
  assert.deepEqual(await snapshot(root), before);
});

test('a different plan consumes the authorization and cannot change disk', async (t) => {
  const { root, host } = await installedHome(t);
  const before = await snapshot(root);
  const { options } = consent();
  await withLifecycle(host, 'purge-test', async (ticket) => {
    const granted = await preflight(host, ticket, options);
    assert.equal(granted.verdict, 'authorized');
    await assert.rejects(execute(host, { ...granted, plan: { ...granted.plan } }), /granted for a different plan/);
    await assert.rejects(execute(host, granted), authorizationError);
  });
  assert.deepEqual(await snapshot(root), before);
});

test('a forged authorization is refused before changing disk', async (t) => {
  const { root, host } = await installedHome(t);
  const before = await snapshot(root);
  const { options } = consent();
  await withLifecycle(host, 'purge-test', async (ticket) => {
    const granted = await preflight(host, ticket, options);
    assert.equal(granted.verdict, 'authorized');
    await assert.rejects(execute(host, { ...granted, authorization: Object.freeze({}) }), authorizationError);
  });
  assert.deepEqual(await snapshot(root), before);
});

test('an authorization is home-bound and a wrong-home attempt consumes it', async (t) => {
  const { root, host } = await installedHome(t);
  const before = await snapshot(root);
  const { options } = consent();
  await withLifecycle(host, 'purge-test', async (ticket) => {
    const granted = await preflight(host, ticket, options);
    assert.equal(granted.verdict, 'authorized');
    await assert.rejects(execute({ ...host, brandRoot: path.join(root, 'other-home') }, granted), /different home/);
    await assert.rejects(execute(host, granted), authorizationError);
  });
  assert.deepEqual(await snapshot(root), before);
});

test('an unreadable home refuses before a corrupt record and never asks consent', async (t) => {
  const { root, host } = await installedHome(t);
  await fs.writeFile(installRecordPath(host), '{');
  const before = await snapshot(root);
  const { options, questions } = consent();
  const savedHome = path.join(root, 'saved-home');
  const outcome = await withLifecycle(host, 'purge-test', async (ticket) => {
    // A real ENOTDIR makes the home unreadable without depending on inspection's I/O bindings.
    await fs.rename(host.brandRoot, savedHome);
    await fs.writeFile(host.brandRoot, 'not a directory');
    try {
      return await preflight(host, ticket, options);
    } finally {
      await fs.unlink(host.brandRoot);
      await fs.rename(savedHome, host.brandRoot);
    }
  });
  assert.deepEqual(outcome, { verdict: 'refused', lines: [
    `Could not read ${host.brandRoot}: purge cannot inventory the home.`,
  ] });
  assert.equal(questions.length, 0);
  assert.deepEqual(await snapshot(root), before);
});

test('a missing record still needs both consents before authorizing package image removal', async (t) => {
  const { root, host } = await installedHome(t);
  await fs.unlink(installRecordPath(host));
  const before = await snapshot(root);
  const { options, questions } = consent();
  const granted = await withLifecycle(host, 'purge-test', (ticket) => preflight(host, ticket, options));
  assert.equal(granted.verdict, 'authorized');
  assert.equal(granted.plan.recordState, 'missing');
  assert.equal(questions.length, 2);
  assert.deepEqual(await snapshot(root), before);
});
