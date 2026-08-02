#!/usr/bin/env node
/**
 * Guards the environment switches:
 *   node --test agents/codex/run-config.test.mjs
 *
 * The point of these cases is that a run's environment is never decided by accident: an
 * absent file means defaults, a broken one stops the run, and what the flags turn into is
 * exactly what `codex exec` receives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRunConfig, writeRunConfig, disableFlags, DEFAULTS } from '../src/run-config.mjs';

const tempFile = (content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cfg-'));
  const file = path.join(dir, 'run-config.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
};

test('an absent file means defaults, not an error', () => {
  const file = path.join(os.tmpdir(), 'codex-cfg-missing', 'run-config.json');
  assert.deepEqual(readRunConfig(file), DEFAULTS);
});

test('defaults keep the operator environment out of a run', () => {
  assert.equal(DEFAULTS.hooks, false);
  assert.equal(DEFAULTS.plugins, false);
  assert.deepEqual(disableFlags(DEFAULTS), ['--disable', 'hooks', '--disable', 'plugins']);
});

test('the tooling that writes alongside a run is named by default', () => {
  // Without .omc/** an honest run in any OMC repository is failed for a file OMC wrote
  // itself — the 2026-08-02 case this list exists for.
  assert.ok(DEFAULTS.environmentPaths.includes('.omc/**'));
  assert.ok(DEFAULTS.environmentPaths.includes('.claude/settings.local.json'));
});

test('the environment list is read as patterns, trimmed', () => {
  const file = tempFile('{"environmentPaths": ["  .omc/**  ", "", "cache.json"]}');
  assert.deepEqual(readRunConfig(file).environmentPaths, ['.omc/**', 'cache.json']);
});

test('an empty environment list is a decision, not a default', () => {
  const file = tempFile('{"environmentPaths": []}');
  assert.deepEqual(readRunConfig(file).environmentPaths, []);
});

test('an environment list that is not a list of strings is an error', () => {
  assert.throws(() => readRunConfig(tempFile('{"environmentPaths": ".omc/**"}')), /list of string patterns/);
  assert.throws(() => readRunConfig(tempFile('{"environmentPaths": [1]}')), /list of string patterns/);
});

test('a switch turned on drops its --disable flag', () => {
  assert.deepEqual(disableFlags({ hooks: true, plugins: false }), ['--disable', 'plugins']);
  assert.deepEqual(disableFlags({ hooks: true, plugins: true }), []);
});

test('a partial file leaves the unnamed key at its default', () => {
  const file = tempFile('{"plugins": true}');
  assert.deepEqual(readRunConfig(file), { ...DEFAULTS, plugins: true });
});

test('malformed JSON stops the run instead of falling back', () => {
  const file = tempFile('{"hooks": tru');
  assert.throws(() => readRunConfig(file), /cannot be parsed as JSON/);
});

test('an unknown key is an error, so a typo cannot pass as a setting', () => {
  const file = tempFile('{"hook": true}');
  assert.throws(() => readRunConfig(file), /unknown key/);
});

test('a non-boolean value is an error', () => {
  const file = tempFile('{"hooks": "on"}');
  assert.throws(() => readRunConfig(file), /true or false/);
});

test('a written config reads back unchanged', () => {
  const file = tempFile();
  writeRunConfig({ hooks: true, plugins: false }, file);
  assert.deepEqual(readRunConfig(file), { ...DEFAULTS, hooks: true });
});

test('the shipped config keeps both switches off', () => {
  const config = readRunConfig();
  assert.equal(config.hooks, false);
  assert.equal(config.plugins, false);
});
