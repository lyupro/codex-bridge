/**
 * Plan_56 D27: persist only the operator's edit, never the reader's merged defaults.
 * Keep unrelated JSON text intact: normalization on read is not permission to rewrite it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BRAND_CONFIG_PATH } from './brand-home.mjs';
import { readJsonFileWithRaw, parseJsonText } from './json-file.mjs';
import { validateRunConfig } from './config-validate.mjs';

function replaceValue(file, raw, key, value) {
  // The shared reader has already checked JSON syntax; tokens locate top-level value spans.
  const tokens = [...raw.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/g)];
  const replacements = [];
  let lastEnd = tokens[0].index + 1;
  for (let index = 1; index < tokens.length - 1;) {
    const name = parseJsonText(file, tokens[index][0]);
    const start = index + 2;
    let end = start;
    if (tokens[start][0] === '{' || tokens[start][0] === '[') {
      let depth = 1;
      while (depth > 0) {
        end += 1;
        if (tokens[end][0] === '{' || tokens[end][0] === '[') depth += 1;
        if (tokens[end][0] === '}' || tokens[end][0] === ']') depth -= 1;
      }
    }
    lastEnd = tokens[end].index + tokens[end][0].length;
    if (name === key) replacements.push([tokens[start].index, lastEnd]);
    index = end + 2;
  }
  if (replacements.length) {
    for (const [start, end] of replacements.reverse()) {
      raw = raw.slice(0, start) + indented(raw, start, value) + raw.slice(end);
    }
    return raw;
  }
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const trailing = raw.slice(lastEnd, tokens.at(-1).index);
  const addition = `${tokens.length > 2 ? ',' : ''}${newline}  ${JSON.stringify(key)}: `
    + value.replaceAll('\n', `${newline}  `)
    + (trailing.includes('\n') ? '' : newline);
  return raw.slice(0, lastEnd) + addition + raw.slice(lastEnd);
}

/**
 * A serialized object knows its own shape but not how deep it is being pasted, so every line
 * after the first came out flush against the margin: writing a role profile left `"models"`
 * indented by two and its `"build"` by none. The file stayed valid JSON and became unreadable
 * for the operator who edits it by hand, which is the audience this whole path exists for.
 */
function indented(raw, start, value) {
  const lineStart = raw.lastIndexOf('\n', start) + 1;
  const indent = /^[ \t]*/.exec(raw.slice(lineStart, start))[0];
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  return indent ? value.replaceAll('\n', `${newline}${indent}`) : value;
}

/** Accepts { key, value } or { reset: true }; the complete config belongs to this boundary. */
export async function editRunConfig(change, file = BRAND_CONFIG_PATH) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) {
    throw new Error('Config edit requires { key, value } or { reset: true }');
  }
  const reset = change.reset === true && Object.keys(change).length === 1;
  if (!reset && (typeof change.key !== 'string' || !change.key
    || !Object.hasOwn(change, 'value')
    || Object.keys(change).some((key) => key !== 'key' && key !== 'value'))) {
    throw new Error('Config edit requires { key, value } or { reset: true }');
  }
  let raw = '{}\n';
  let parsed = {};
  try {
    ({ raw, value: parsed } = await readJsonFileWithRaw(file));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let text;
  if (reset) {
    text = '{}\n';
  } else {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      validateRunConfig(file, parsed);
    }
    validateRunConfig(file, { ...parsed, [change.key]: change.value });
    const value = JSON.stringify(change.value, null, 2);
    text = replaceValue(file, raw, change.key, value);
  }
  // Validate the exact bytes to be persisted, before even creating a temporary file (D27).
  const config = validateRunConfig(file, parseJsonText(file, text));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.close();
    await fs.rename(temporary, file);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true });
    throw error;
  }
  return config;
}
