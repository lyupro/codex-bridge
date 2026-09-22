/**
 * Locks the shared agent data and rejects copied role lists in source.
 *
 * Five independent lists let a new agent silently miss model validation, a budget, the order
 * gate or the reply guard; checking current values alone would let the next copied list recreate
 * that defect. Both spellings are guarded: the fifth copy (reply-guard.mjs, found on acceptance
 * 2026-09-06) held the FULL names, so a gate that knew only the short ones would have missed it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, agentRole } from '../src/home/lib/agents.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the registry owns execution agents and the phased advisor defaults from Plan_59', () => {
  assert.deepEqual(AGENTS, {
    'codex-scout': { role: 'scout', budget: 15, writes: false, result: 'result.json' },
    'codex-build': { role: 'build', budget: 25, writes: true, result: 'result.json' },
    'codex-review': { role: 'review', budget: 20, writes: false, result: 'review.json' },
    'codex-advisor': { role: 'advisor', budget: { scope: 5, advise: 15 }, writes: false, result: 'result.json' },
  });
  for (const [name, agent] of Object.entries(AGENTS)) {
    assert.equal(typeof agent.role, 'string', `${name} must have a role`);
    assert.ok(agent.role.trim(), `${name} must have a non-empty role`);
    const budgets = name === 'codex-advisor' ? Object.values(agent.budget) : [agent.budget];
    for (const budget of budgets) {
      assert.equal(typeof budget, 'number', `${name} must have numeric phase budgets`);
      assert.ok(Number.isFinite(budget) && budget > 0, `${name} must have positive phase budgets`);
    }
    assert.equal(typeof agent.writes, 'boolean', `${name} must declare write access`);
    assert.equal(agent.writes, name === 'codex-build');
  }
});

test('agentRole maps full agent names and leaves an unknown name undefined', () => {
  assert.equal(agentRole('codex-scout'), 'scout');
  assert.equal(agentRole('codex-build'), 'build');
  assert.equal(agentRole('codex-review'), 'review');
  assert.equal(agentRole('codex-advisor'), 'advisor');
  assert.equal(agentRole('codex-unknown'), undefined);
});

function findSourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return findSourceFiles(target);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [target] : [];
  });
}

function hasCopiedRoleList(source) {
  const lists = source.matchAll(
    /\[\s*((['"`])(?:codex-)?(?:scout|build|review|advisor)\2(?:\s*,\s*(['"`])(?:codex-)?(?:scout|build|review|advisor)\3){2,}\s*,?)\s*\]/g,
  );
  return [...lists].some(([, list]) => {
    const roles = [...list.matchAll(/['"`](?:codex-)?(scout|build|review|advisor)['"`]/g)].map(([, role]) => role);
    return new Set(roles).size >= 3;
  });
}

test('the role-list gate recognizes both spellings in every ordering, as an array or a Set', () => {
  // Built by concatenation rather than as a template literal: the list this gate hunts for is
  // usually written across several lines, and spelling that newline out here keeps the fixture
  // readable without an escape sequence inside an escaped string.
  const NL = String.fromCharCode(10);
  const orderings = [
    ['scout', 'build', 'review'], ['scout', 'review', 'build'],
    ['build', 'scout', 'review'], ['build', 'review', 'scout'],
    ['review', 'scout', 'build'], ['review', 'build', 'scout'],
  ];
  for (const prefix of ['', 'codex-']) {
    for (const roles of orderings) {
      for (const quote of ["'", '"', '`']) {
        const quoted = roles.map((role) => quote + prefix + role + quote);
        for (const literal of [
          '[' + quoted.join(', ') + ']',
          '[' + NL + quoted.join(',' + NL) + ',' + NL + ']',
        ]) {
          assert.ok(hasCopiedRoleList(literal), literal);
          assert.ok(hasCopiedRoleList('new Set(' + literal + ')'), literal);
        }
      }
    }
  }
  // The exact line that survived in reply-guard.mjs until acceptance caught it by hand.
  assert.ok(hasCopiedRoleList("const GUARDED = new Set(['codex-scout', 'codex-build', 'codex-review']);"));
  // Plan_59: a fourth agent must not make the duplicate-list regression guard stop matching.
  for (const ordering of orderings) {
    for (let index = 0; index <= ordering.length; index += 1) {
      const roles = ordering.toSpliced(index, 0, 'advisor');
      for (const prefix of ['', 'codex-']) {
        assert.ok(hasCopiedRoleList(JSON.stringify(roles.map((role) => `${prefix}${role}`))));
      }
    }
  }
  assert.equal(hasCopiedRoleList("['scout', 'build']"), false);
  assert.equal(hasCopiedRoleList("['scout', 'scout', 'review']"), false);
  assert.equal(hasCopiedRoleList("['codex-scout', 'codex-scout', 'codex-review']"), false);
  assert.equal(hasCopiedRoleList('new Set(Object.keys(AGENTS))'), false);
});

test('source reads agent roles from the registry instead of copying the list', () => {
  const unexpected = ['src', 'cli'].flatMap((dir) => findSourceFiles(path.join(root, dir)))
    .map((file) => ({
      file: path.relative(root, file).replaceAll(path.sep, '/'),
      source: fs.readFileSync(file, 'utf8'),
    }))
    .filter(({ file, source }) => file !== 'src/home/lib/agents.mjs' && hasCopiedRoleList(source))
    .map(({ file }) => file)
    .sort();

  assert.deepEqual(
    unexpected,
    [],
    `Copied agent role lists must read src/home/lib/agents.mjs instead: ${unexpected.join(', ')}`,
  );
});
