/**
 * Plan_56 D27: persist only the operator's edit, never the reader's merged defaults.
 * Keep unrelated JSON text intact: normalization on read is not permission to rewrite it.
 * Plan_56 D40/D41: caller-side reads lost edits during catalogue waits. Transform fresh bytes
 * here and retry if they change. Plan_56 D44: three separate model-set processes all reported
 * success while one edit vanished; hold the shared lock across transforms, retries, and publish.
 * Transformers may run three times, so network work belongs before this boundary.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BRAND_CONFIG_PATH } from './brand-home.mjs';
import { parseJsonText } from './json-file.mjs';
import { validateRunConfig } from './config-validate.mjs';
import { withFileLock } from './file-lock.mjs';

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

async function readBytes(file) {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function readBytesSync(file) {
  try {
    return fsSync.readFileSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

export async function editRunConfig(key, transform, file = BRAND_CONFIG_PATH) {
  const reset = key !== null && typeof key === 'object' && !Array.isArray(key)
    && key.reset === true && Object.keys(key).length === 1 && transform === undefined;
  if (!reset && (typeof key !== 'string' || !key || typeof transform !== 'function')) {
    throw new Error('Config edit requires a non-empty string key and a transformer function or { reset: true }');
  }
  const directory = path.dirname(file);
  const created = await fs.mkdir(directory, { recursive: true });
  try {
    return await withFileLock(`${file}.lock`, async () => {
      let collision;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const original = await readBytes(file);
        const raw = original === null ? '{}\n' : original.toString('utf8');
        const parsed = parseJsonText(file, raw);
        let text;
        if (reset) {
          text = '{}\n';
        } else {
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            validateRunConfig(file, parsed);
          }
          const value = await transform(Object.hasOwn(parsed, key) ? parsed[key] : undefined);
          validateRunConfig(file, { ...parsed, [key]: value });
          text = replaceValue(file, raw, key, JSON.stringify(value, null, 2));
        }
        // Validate the exact bytes to be persisted, before even creating a temporary file (D27).
        const config = validateRunConfig(file, parseJsonText(file, text));
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
        const handle = await fs.open(temporary, 'wx');
        try {
          await handle.writeFile(text, 'utf8');
          await handle.close();
          // Comparing and publishing must be one step. Awaiting between them hands the event loop to
          // a sibling edit, and a live probe of three concurrent `model set` calls lost one of them
          // silently: every comparison passed before the first rename ran. Synchronous calls leave no
          // suspension point between the two, so a competing edit is seen by whoever compares second.
          const current = readBytesSync(file);
          if (original === null ? current !== null : current === null || !original.equals(current)) {
            await fs.rm(temporary, { force: true });
            continue;
          }
          fsSync.renameSync(temporary, file);
          return config;
        } catch (error) {
          await handle.close().catch(() => {});
          await fs.rm(temporary, { force: true });
          // Windows refuses the rename outright when another process is publishing onto the same name
          // at that instant: two concurrent `model set` calls returned EPERM here on a live probe, and
          // one operator edit was lost with the file system's wording instead of an answer. A collision
          // is retried like a byte change; a lasting one is reported in its own words, not as drift.
          if ((error.code === 'EPERM' || error.code === 'EBUSY') && attempt < 2) {
            collision = error;
            continue;
          }
          throw error;
        }
      }
      if (collision) throw collision;
      throw new Error(`${file}: config kept changing under the edit; nothing was written. Run the command again.`);
    });
  } catch (error) {
    // D44 needs the parent before validation to lock even a new config. Undo only empty parents
    // this call created, preserving D27's refusal contract and anything a competing writer added.
    if (created) {
      // Windows mkdir returns a namespaced path; compare that form on both sides of the boundary.
      const boundary = path.toNamespacedPath(path.resolve(created));
      for (let current = path.toNamespacedPath(path.resolve(directory));
        current === boundary || current.startsWith(`${boundary}${path.sep}`); current = path.dirname(current)) {
        try { await fs.rmdir(current); } catch { break; }
      }
    }
    throw error;
  }
}
