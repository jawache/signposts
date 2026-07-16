// src/core/depcruise.mjs — the generic import-fence runner. Orchestrates dependency-cruiser
// (never reimplements it — same doctrine as ast-grep): compiles the signposts layers-&-fences
// dialect to depcruise's native config, runs the tool, and maps each violation to an engine hit
// naming the fence and its `why`. A native `.cjs` via `config:` is the escape hatch — passed
// through untouched for the long tail of depcruise's schema the dialect deliberately doesn't cover.
//
// Contract: kind 'project' → ctx = { root } (a whole-graph check). Prefer commit/turn; too heavy
// to run per keystroke. dependency-cruiser is a baseline dep (beside @ast-grep/napi), so a fresh
// scaffold has it — a core script whose tool might be missing would be a broken promise.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { compileDialect } from './pure/depcruise-compile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Locate dependency-cruiser's CLI, resolved relative to THIS package first (robust to whether the
// consumer hoisted it) then the consumer root. Returns an absolute path to the .mjs bin, or null.
function findBin(root) {
  const rel = join('node_modules', 'dependency-cruiser', 'bin', 'dependency-cruise.mjs');
  const candidates = [];
  let dir = HERE;
  for (let i = 0; i < 6; i++) { candidates.push(join(dir, rel)); const up = dirname(dir); if (up === dir) break; dir = up; }
  candidates.push(join(root, rel));
  return candidates.find((c) => existsSync(c)) || null;
}

// Default scan target: a glob over common source extensions (a bare directory arg makes depcruise
// cruise zero modules). A `scan:` that already looks glob-ish is used verbatim.
function scanTarget(rule) {
  const scan = rule.scan || 'src';
  return /[*.]/.test(scan) ? scan : `${scan}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`;
}

export function runDepcruise(rule, ctx) {
  const bin = findBin(ctx.root);
  if (!bin) return ['depcruise: dependency-cruiser not found (it ships as a signposts baseline dep — run `npm install`).'];

  let configPath, tmp = null;
  if (rule.config) {                                           // native escape hatch — run untouched
    configPath = isAbsolute(rule.config) ? rule.config : join(ctx.root, rule.config);
    if (!existsSync(configPath)) return [`depcruise: config file not found: ${rule.config}`];
  } else {
    tmp = mkdtempSync(join(tmpdir(), 'sg-dc-'));
    configPath = join(tmp, 'dc.cjs');
    writeFileSync(configPath, 'module.exports = ' + JSON.stringify(compileDialect(rule), null, 2) + ';\n');
  }

  try {
    const r = spawnSync(process.execPath, [bin, '--config', configPath, '--output-type', 'json', scanTarget(rule)],
      { cwd: ctx.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let json;
    try { json = JSON.parse(r.stdout || ''); }
    catch {                                                    // no parseable JSON → a real failure (bad config, tool error)
      if (r.status === 0) return [];
      return [`depcruise failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n')}`];
    }
    const violations = (json.summary && json.summary.violations) || [];
    return violations.map((v) => {
      const name = v.rule?.name || 'fence';
      const why = v.comment || v.rule?.comment || '';         // the fence's own reason, when depcruise echoes it
      return `${name}: ${v.from} → ${v.to}${why ? ` — ${why}` : ''}`;
    });
  } finally {
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

export default {
  kind: 'project',
  evaluate(rule, ctx) { return runDepcruise(rule, ctx); },
  test() {
    // Fixture: a domain (core) that imports db (effects) directly + through a helper. Proves the
    // fence fires, transitive reach is caught, a type-only import passes, and an unvetted package
    // blocks — plus the native-config escape hatch runs a raw .cjs untouched.
    const root = mkdtempSync(join(tmpdir(), 'sg-dc-test-'));
    const w = (p, s) => { const abs = join(root, p); const d = dirname(abs); if (!existsSync(d)) mkdirSync(d, { recursive: true }); writeFileSync(abs, s); };
    try {
      mkdirSync(join(root, 'src/lib/x'), { recursive: true });
      w('src/lib/x/db.ts', 'export const save = () => 1;\n');
      w('src/lib/x/helper.ts', "import { save } from './db';\nexport const via = () => save();\n");
      w('src/lib/x/types.ts', 'export type Row = { id: number };\n');
      // domain reaches db only THROUGH helper (transitive), and imports a type-only shape.
      w('src/lib/x/domain.ts', "import { via } from './helper';\nimport type { Row } from './types';\nexport const run = (r: Row) => via();\n");

      const base = {
        layers: {
          core: ['src/lib/**/domain.ts'],
          effects: ['src/lib/**/db.ts'],
          helpers: ['src/lib/**/helper.ts'],
          types: ['src/lib/**/types.ts'],
        },
      };
      // transitive: core must not REACH effects, even through a helper.
      const transitive = this.evaluate({ ...base, forbid: [{ from: 'core', to: 'effects', transitive: true, why: 'purity is transitive' }] }, { root });
      const blocksTransitive = transitive.some((h) => /no-core-to-effects/.test(h));
      // type-only carve-out: core → types is fine because it's `import type` (elided at compile).
      const typeOnly = this.evaluate({ ...base, except: ['type-only'], forbid: [{ from: 'core', to: 'types' }] }, { root });
      const typePasses = typeOnly.length === 0;

      // fail-closed only: core may import ONLY [core, safe]; an unlisted import blocks, a listed one passes.
      w('src/lib/x/safe.ts', 'export const ok = 1;\n');
      w('src/lib/x/unlisted.ts', 'export const sneaky = () => 1;\n');
      w('src/lib/x/domain.ts', "import { ok } from './safe';\nimport { sneaky } from './unlisted';\nexport const run = () => ok + sneaky();\n");
      const only = this.evaluate({ layers: { core: ['src/lib/**/domain.ts'], safe: ['src/lib/**/safe.ts'] }, only: { core: ['core', 'safe'] } }, { root });
      const blocksUnlisted = only.some((h) => /core-only/.test(h) && /unlisted/.test(h)) && !only.some((h) => /safe\.ts/.test(h));

      // node builtins hole: a domain importing node:fs blocks.
      w('src/lib/x/domain.ts', "import fs from 'node:fs';\nexport const run = () => fs;\n");
      const nodefx = this.evaluate({ layers: { core: ['src/lib/**/domain.ts'], 'node-fx': ['node:*'] }, forbid: [{ from: 'core', to: 'node-fx', why: 'builtins are effects' }] }, { root });
      const blocksNode = nodefx.some((h) => /no-core-to-node-fx/.test(h));

      // native escape hatch: a raw .cjs runs untouched.
      w('src/lib/x/domain.ts', "import { save } from './db';\nexport const run = () => save();\n");
      w('dc.cjs', "module.exports = { forbidden: [{ name: 'raw-native', severity: 'error', from: { path: 'domain\\\\.ts$' }, to: { path: 'db\\\\.ts$' } }], options: { enhancedResolveOptions: { extensions: ['.ts'] } } };\n");
      const native = this.evaluate({ config: 'dc.cjs' }, { root });
      const nativeRuns = native.some((h) => /raw-native/.test(h));

      const pass = blocksTransitive && typePasses && blocksUnlisted && blocksNode && nativeRuns;
      return { name: 'core/depcruise', pass };
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
};
