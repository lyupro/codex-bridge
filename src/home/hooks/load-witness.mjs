#!/usr/bin/env node
/**
 * Plan_64 D11: only InstructionsLoaded witnesses the host loading the rules core.
 * The 2026-10-10 live run fired before the transcript existed, so persist now and resolve later.
 * Observation must never refuse a host action, including doctor's empty-stdin dry run.
 */
import fs from 'node:fs';
import { BRAND_STATE_DIR } from '../lib/brand-home.mjs';
import { parseJsonText } from '../lib/json-file.mjs';
import { recordCoreLoad } from '../lib/load-witness.mjs';

try {
  const raw = fs.readFileSync(0, 'utf8');
  if (raw.trim()) {
    const input = parseJsonText('stdin', raw);
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      await recordCoreLoad({ stateDir: BRAND_STATE_DIR, input });
    }
  }
} catch {
  // D11: lost evidence is not a refusal; preserve corrupt state for inspection.
}
process.exit(0);
