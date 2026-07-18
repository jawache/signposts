#!/usr/bin/env node
// rules/tooling/justfile-docs.mjs — every justfile recipe carries a [doc("…")].
//
// A JS own-script in the `justfile` pack, built like any core script. It's
// wired in signposts.yaml as `use: tooling/justfile-docs`.
//
// `just --list` is the command catalogue's help screen; without an explicit [doc]
// attribute it falls back to the LAST comment line above a recipe, which for
// multi-line comment blocks is a mid-sentence fragment. An explicit [doc("…")]
// makes the help declared, not inferred — this keeps that true for every recipe.
//
// A recipe that legitimately needs no doc is marked [private] (or named with a
// leading `_`) — just hides those from `just --list`, so there's no help line to
// get wrong. That is the precise, code-visible exemption; there is no config
// escape hatch (no exempt name-list to rubber-stamp).
//
// Contract: kind 'content' → evaluate(rule, ctx={ path, content, root, … }); the
// whole rule entry arrives verbatim as `rule`.
//
// Usage:  node rules/tooling/justfile-docs.mjs <justfile> [...]   (exit 2)
//         node rules/tooling/justfile-docs.mjs --test             (self-test)

import { readFileSync } from 'node:fs';

// Words that open a non-recipe construct at column 0.
const RESERVED = new Set(['set', 'alias', 'export', 'import', 'mod', 'unexport']);

// Pure: returns recipes with no [doc(…)] attribute, as { name, line } (1-based).
// A recipe hidden from `just --list` is exempt — it has no help line to get wrong —
// and `just` hides two kinds: an `_`-prefixed name, and a recipe carrying [private].
export function undocumentedRecipes(text) {
  const lines = text.split('\n');
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(@?[A-Za-z_][A-Za-z0-9_-]*)(\s|:)/);
    if (!m) continue; // indented (body), comment, attribute, blank
    const name = m[1].replace(/^@/, '');
    if (RESERVED.has(name)) continue;
    const colon = line.indexOf(':');
    if (colon === -1 || line[colon + 1] === '=') continue; // not a recipe / an assignment
    if (name.startsWith('_')) continue;                    // `_`-prefixed → hidden from `just --list`
    // Walk up over the recipe's contiguous attribute lines ([private], [doc(…)], …).
    let exempt = false;
    for (let j = i - 1; j >= 0; j--) {
      const above = lines[j];
      if (!/^\[.*\]\s*$/.test(above)) break;
      if (/\bdoc\(/.test(above) || /\bprivate\b/.test(above)) { exempt = true; break; }  // documented, or hidden
    }
    if (!exempt) bad.push({ name, line: i + 1 });
  }
  return bad;
}


function selfTest() {
  const legal = [
    '# catalogue header comment',
    'export PATH := "x:" + env_var("PATH")',
    'set shell := ["bash", "-c"]',
    'alias t := test',
    '',
    '# longer commentary explaining the recipe',
    '# across multiple lines.',
    '[doc("Run the dev server.")]',
    'dev port=`cat .wt-port 2>/dev/null || echo 4321`:',
    '    astro dev --port {{port}}',
    '',
    '[private]',
    '[doc("Inject env then run CMD.")]',
    'dx env +cmd:',
    '    dotenvx run -- {{cmd}}',
  ].join('\n');
  const illegal = [
    '# only a comment above — the fallback heuristic, not a declared doc',
    'build env="dev":',
    '    astro build',
    '',
    '[doc("Documented fine.")]',
    'preview:',
    '    astro preview',
    '',
    'bare-recipe arg:',
    '    echo {{arg}}',
  ].join('\n');

  const legalOk = undocumentedRecipes(legal).length === 0;
  const found = undocumentedRecipes(illegal);
  const illegalOk =
    found.length === 2 &&
    found[0].name === 'build' && found[0].line === 2 &&
    found[1].name === 'bare-recipe' && found[1].line === 9;

  // the code-visible exemptions: a [private] recipe and an `_`-prefixed name are
  // both hidden from `just --list`, so neither needs a doc.
  const hiddenOk = undocumentedRecipes([
    '[private]',
    'secret:',
    '    echo hi',
    '',
    '_helper arg:',
    '    echo {{arg}}',
  ].join('\n')).length === 0;

  const ok = legalOk && illegalOk && hiddenOk;
  console.log(ok ? 'PASS tooling/justfile-docs' : 'FAIL tooling/justfile-docs');
  process.exit(ok ? 0 : 1);
}

// The rule object the engine loads via `use: tooling/justfile-docs`; ctx.content is
// the reconstructed justfile.
export default {
  kind: 'content',
  evaluate(rule, ctx) {
    return undocumentedRecipes(ctx.content)
      .map((r) => `recipe '${r.name}' (line ${r.line}) has no [doc("…")] attribute (or mark it [private] if it should stay off \`just --list\`)`);
  },
};

// CLI only when run directly — NOT when imported by the engine (else this would
// execute against the engine's argv and exit the process mid-evaluate).
const isMain = process.argv[1] && process.argv[1].endsWith('justfile-docs.mjs');
if (isMain) {
  if (process.argv[2] === '--test') selfTest();
  else process.exit(0);
}
