#!/usr/bin/env node
// src/cli/scan.mjs — `npx signposts scan`: the alignment scan (the THIRD trigger).
//
// Runs every per-file rule over the whole tree and REPORTS the violations — answers
// "is my codebase aligned to my signposts?". Unlike edit/commit it NEVER blocks and
// never logs: it always exits 0, so pulling a rule into an old repo can't wedge
// anything — the rules already stop NEW violations; scan reveals the existing ones.
//
//   npx signposts scan            grouped human report
//   npx signposts scan --json     the raw { byRule, counts, skipped } object
//
// Triage/fixing what it finds is a /signposts skill conversation (facts vs judgement).

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTree } from '../engine.mjs';

export async function scan({ root = process.cwd(), json = false } = {}) {
  try {
    const result = await scanTree({ root, configPath: undefined });
    if (json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exit(0); }

    const { byRule, counts, skipped } = result;
    const ids = Object.keys(byRule);
    if (!ids.length) {
      console.log(`✓ aligned — no violations across ${counts.files} files (${counts.rules} rules scanned).`);
    } else {
      for (const id of ids) {
        const hits = byRule[id];
        const msg = hits[0]?.message ? ` — ${String(hits[0].message).split('\n')[0].trim()}` : '';
        console.log(`\n✗ ${id}${msg}`);
        for (const h of hits) console.log(`    ${h.path}${h.hits[0] ? ` — ${h.hits[0]}` : ''}`);
      }
      const skip = skipped.length ? ` · skipped ${skipped.length} non-file rule${skipped.length > 1 ? 's' : ''} (${skipped.join(', ')})` : '';
      console.log(`\n${counts.violations} violation${counts.violations === 1 ? '' : 's'} · ${counts.files} files scanned · ${counts.rules} rules${skip}`);
      console.log('scan reports only — nothing was blocked. Fix or triage with the /signposts skill.');
    }
  } catch (e) {
    // scan must never block adoption — report the failure LOUDLY (not as "aligned"), still exit 0.
    console.error(`signposts scan failed (not "aligned"): ${e?.message || e}`);
  }
  process.exit(0);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const t = args.indexOf('--target');
  scan({ root: t >= 0 ? resolve(args[t + 1]) : process.cwd(), json: args.includes('--json') });
}
