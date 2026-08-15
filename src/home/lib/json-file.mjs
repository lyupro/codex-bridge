/**
 * Reads JSON written by another program and keeps its file boundary in one place.
 *
 * Plan_24 records the live Windows incident: PowerShell Out-File -Encoding utf8 wrote a BOM
 * that Claude Code accepted but JSON.parse rejected. Readers must strip that BOM consistently.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';

export function parseJsonText(file, raw) {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message}`, { cause: error });
  }
}

export async function readJsonFile(file) {
  return parseJsonText(file, await fsp.readFile(file, 'utf8'));
}

export async function readJsonFileWithRaw(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return { raw, value: parseJsonText(file, raw) };
}

export function readJsonFileSync(file) {
  return parseJsonText(file, fs.readFileSync(file, 'utf8'));
}
