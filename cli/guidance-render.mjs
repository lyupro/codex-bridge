/** Plan_79 B1: guidance derives owned values from the installed home, never a second list. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GUIDANCE_TOPICS } from './guidance-topics.mjs';

const codeList = (values) => values.map((value) =>
  value.includes('`') ? '`` ' + value + ' ``' : '`' + value + '`').join(', ');

function renderError(topic, placeholder, message) {
  return new Error(`Cannot render guidance topic "${topic}" placeholder "${placeholder}": ${message}`);
}

export async function renderGuidance(text, { root, topic, configPath }) {
  const values = new Map();
  for (const [placeholder, name] of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
    if (values.has(placeholder)) continue;
    try {
      // The 2026-08-26 seeded-config incident requires file URLs rooted in the installed home.
      if (name === 'shell-unsafe-sequences') {
        const { SHELL_UNSAFE_SEQUENCES } = await import(pathToFileURL(path.join(root, 'lib', 'shell-unsafe.mjs')).href);
        values.set(placeholder, codeList(SHELL_UNSAFE_SEQUENCES));
      } else if (name === 'review-required-fields') {
        const { SCHEMAS } = await import(pathToFileURL(path.join(root, 'lib', 'runner', 'schemas.mjs')).href);
        const review = SCHEMAS['codex-review'];
        values.set(placeholder, `Top-level fields: ${codeList(review.required)}; finding fields: ${codeList(review.properties.findings.items.required)}`);
      } else if (name === 'agent-budgets') {
        if (!configPath) throw new Error('configPath is required');
        const { AGENTS } = await import(pathToFileURL(path.join(root, 'lib', 'agents.mjs')).href);
        const { readRunConfig } = await import(pathToFileURL(path.join(root, 'lib', 'run-config.mjs')).href);
        const { config, budgetSources } = readRunConfig(configPath, { provenance: true });
        const rows = Object.entries(AGENTS).flatMap(([agent, { role }]) => {
          const phases = Object.entries(config.budgets[role]);
          return phases.map(([phase, minutes]) =>
            `| ${agent} | ${phases.length === 1 ? '—' : phase} | ${minutes} | ${budgetSources[role].has(phase) ? 'host config' : 'package'} |`);
        });
        values.set(placeholder, [
          `Budgets the runner enforces on this host. \`host config\` values come from ${configPath}.`,
          '', '| Agent | Phase | Minutes | Source |', '| --- | --- | --- | --- |', ...rows,
        ].join('\n'));
      } else if (name.startsWith('order-rules:')) {
        const ruleTopic = name.slice('order-rules:'.length);
        if (ruleTopic !== 'all' && !Object.hasOwn(GUIDANCE_TOPICS, ruleTopic)) {
          throw new Error(`unknown order rule topic "${ruleTopic}"`);
        }
        const { ORDER_RULES } = await import(pathToFileURL(path.join(root, 'lib', 'order-rules.mjs')).href);
        const rules = Object.entries(ORDER_RULES);
        const items = (owner) => rules.filter(([, rule]) => rule.topic === owner)
          .map(([key, rule]) => `- \`${key}\`: ${rule.rule}`).join('\n');
        const block = ruleTopic === 'all'
          ? Object.keys(GUIDANCE_TOPICS).map((owner) => {
            const list = items(owner);
            return list ? `Topic \`${owner}\`:\n${list}` : '';
          }).filter(Boolean).join('\n\n')
          : items(ruleTopic);
        if (!block) throw new Error('no order rules to render');
        values.set(placeholder, block);
      } else {
        throw new Error('unknown placeholder');
      }
    } catch (error) {
      throw renderError(topic, placeholder, error.message);
    }
  }
  const rendered = text.replace(/\{\{([^{}]*)\}\}/g, (placeholder) => values.get(placeholder));
  const unresolved = rendered.indexOf('{{');
  if (unresolved !== -1) {
    const placeholder = rendered.slice(unresolved).split(/\r?\n/, 1)[0];
    throw renderError(topic, placeholder, 'unresolved placeholder');
  }
  return rendered;
}
