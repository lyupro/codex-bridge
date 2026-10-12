/** Plan_79 B1: guidance derives owned values from the installed home, never a second list. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const codeList = (values) => values.map((value) =>
  value.includes('`') ? '`` ' + value + ' ``' : '`' + value + '`').join(', ');

function renderError(topic, placeholder, message) {
  return new Error(`Cannot render guidance topic "${topic}" placeholder "${placeholder}": ${message}`);
}

export async function renderGuidance(text, { root, topic }) {
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
