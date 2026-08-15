/** Verifies that installed markdown definitions remain readable as flat YAML frontmatter. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { plannedContent } from '../../cli/copy.mjs';
import { normalizeFrontmatter, parseFrontmatter } from '../../cli/frontmatter.mjs';
import { buildInstallPlan } from '../../cli/manifest.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import {
  renderRequiredInputSummary,
  renderRequiredInputs,
} from '../../src/home/lib/required-inputs.mjs';
import { renderNoSelfExecution } from '../../src/home/lib/no-self-execution.mjs';
import { renderStopSummary } from '../../src/home/lib/stop-contract.mjs';

function intendedValues(source, installationRoot, agentType) {
  const sourceValues = parseFrontmatter(normalizeFrontmatter(source));
  const replacements = new Map([
    ['{{CODEX_BRIDGE_DIR}}', path.resolve(installationRoot).split(path.sep).join('/')],
    ['{{CODEX_REQUIRED_INPUTS_SUMMARY}}', renderRequiredInputSummary(agentType)],
    ['{{CODEX_REQUIRED_INPUTS}}', renderRequiredInputs(agentType)],
    ['{{CODEX_NO_SELF_EXECUTION}}', renderNoSelfExecution()],
    ['{{CODEX_STOP_SUMMARY}}', renderStopSummary()],
  ]);
  return Object.fromEntries(Object.entries(sourceValues).map(([key, value]) => {
    let replaced = value;
    for (const [placeholder, replacement] of replacements) {
      replaced = replaced.replaceAll(placeholder, replacement);
    }
    return [key, replaced];
  }));
}

test('frontmatter normalization quotes YAML-sensitive values without touching the body', () => {
  const body = '\nBody: stays "exactly" as written.\\path\n';
  const source = [
    '---',
    'safe: ordinary value',
    'colon: before: after',
    'comment: before # after',
    'double: "starts with a quote',
    "single: 'starts with a quote",
    'bracket: [value',
    'brace: {value',
    'anchor: &value',
    'alias: *value',
    'tag: !value',
    'literal: |value',
    'folded: >value',
    'directive: %value',
    'reserved: @value',
    'backtick: `value',
    'hyphen: - value',
    'leading:  value',
    'trailing: value ',
    'escaped: C:\\path: "value"',
    '---',
  ].join('\n') + body;

  const normalized = normalizeFrontmatter(source);
  assert.equal(normalized.slice(normalized.indexOf('\n---\n') + 4), body);
  assert.match(normalized, /^safe: ordinary value$/m);
  for (const key of [
    'colon', 'comment', 'double', 'single', 'bracket', 'brace', 'anchor', 'alias', 'tag',
    'literal', 'folded', 'directive', 'reserved', 'backtick', 'hyphen', 'leading',
    'trailing', 'escaped',
  ]) {
    assert.match(normalized, new RegExp(`^${key}: "`, 'm'), `${key} must be double quoted`);
  }
  assert.deepEqual(parseFrontmatter(normalized), {
    safe: 'ordinary value',
    colon: 'before: after',
    comment: 'before # after',
    double: '"starts with a quote',
    single: "'starts with a quote",
    bracket: '[value',
    brace: '{value',
    anchor: '&value',
    alias: '*value',
    tag: '!value',
    literal: '|value',
    folded: '>value',
    directive: '%value',
    reserved: '@value',
    backtick: '`value',
    hyphen: '- value',
    leading: ' value',
    trailing: 'value ',
    escaped: 'C:\\path: "value"',
  });
});

test('content without a frontmatter block passes through unchanged', () => {
  const content = '# Command\n\nBody: untouched.\n';
  assert.equal(normalizeFrontmatter(content), content);
  assert.equal(parseFrontmatter(content), null);
});

test('flat reader rejects the unquoted colon that broke agent registration', () => {
  assert.throws(
    () => parseFrontmatter('---\ndescription: before `TaskStop`: TaskStop removes the wrapper\n---\n'),
    /invalid plain scalar/,
  );
});

test('every installed agent frontmatter round-trips the real placeholder substitution', async () => {
  const root = path.join(os.tmpdir(), 'bridge-frontmatter-host');
  const host = resolveHost({
    host: root,
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
  const agents = (await buildInstallPlan(host))
    .filter((item) => /[\\/]src[\\/]agents[\\/][^\\/]+\.md$/.test(item.source));

  assert.ok(agents.length > 0, 'the package must produce agent definitions');
  for (const item of agents) {
    const agentType = path.basename(item.source, '.md');
    const source = await fs.readFile(item.source, 'utf8');
    const emitted = (await plannedContent(item, host.brandRoot)).toString('utf8');
    const parsed = parseFrontmatter(emitted);
    assert.deepEqual(parsed, intendedValues(source, item.installationRoot, agentType), agentType);
    assert.equal(parsed.name, agentType);
    assert.ok(parsed.description.includes(renderStopSummary()), `${agentType} keeps the TaskStop sentence verbatim`);
  }
});
