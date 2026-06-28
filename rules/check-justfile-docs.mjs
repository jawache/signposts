#!/usr/bin/env node
// rules/check-justfile-docs.mjs — every justfile recipe carries a [doc("…")].
//
// `just --list` is the command catalogue's help screen; without an explicit
// [doc] attribute it falls back to the LAST comment line above a recipe, which
// for multi-line comment blocks is a mid-sentence fragment (a stray URL was
// the `dev` recipe's help for a while). An explicit [doc("…")] makes the help
// declared, not inferred — this check keeps that true for every recipe.
//
// Config (read from signposts.yaml `rules.justfile-docs`):
//   exempt: [name, …]   recipe names that don't require a [doc] (throwaway helpers).
//
// Usage:  node rules/check-justfile-docs.mjs <justfile> [...]   (exit 2)
//         node rules/check-justfile-docs.mjs --test             (self-test)

import { readFileSync } from 'node:fs';
import { ruleConfig } from './_config.mjs';

// Words that open a non-recipe construct at column 0.
const RESERVED = new Set(['set', 'alias', 'export', 'import', 'mod', 'unexport']);

// Pure: returns recipes with no [doc(…)] attribute, as { name, line } (1-based).
// `exempt` (from signposts.yaml) is a list of recipe names that don't need a doc.
export function undocumentedRecipes(text, exempt = []) {
  const ex = new Set(exempt);
  const lines = text.split('\n');
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(@?[A-Za-z_][A-Za-z0-9_-]*)(\s|:)/);
    if (!m) continue; // indented (body), comment, attribute, blank
    const name = m[1].replace(/^@/, '');
    if (RESERVED.has(name) || ex.has(name)) continue;
    const colon = line.indexOf(':');
    if (colon === -1 || line[colon + 1] === '=') continue; // not a recipe / an assignment
    // Walk up over the recipe's contiguous attribute lines ([private], [doc(…)], …).
    let documented = false;
    for (let j = i - 1; j >= 0; j--) {
      const above = lines[j];
      if (!/^\[.*\]\s*$/.test(above)) break;
      if (/\bdoc\(/.test(above)) { documented = true; break; }
    }
    if (!documented) bad.push({ name, line: i + 1 });
  }
  return bad;
}

function runFiles(files) {
  const { exempt = [] } = ruleConfig('justfile-docs'); // reads signposts.yaml
  let failed = false;
  for (const f of files) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const bad = undocumentedRecipes(text, exempt);
    if (bad.length) {
      failed = true;
      process.stderr.write(
        `\n\x1b[31m✗ justfile recipe(s) missing a [doc("…")] attribute\x1b[0m\n` +
        `  File: ${f}\n` +
        bad.map((r) => `    • ${r.name}  (line ${r.line})`).join('\n') + `\n\n` +
        `  \`just --list\` is the catalogue's help screen; without [doc] it falls\n` +
        `  back to the last comment line, which reads as a mid-sentence fragment\n` +
        `  for multi-line blocks. Add, directly above the recipe header:\n` +
        `    [doc("One-line summary a stranger could act on.")]\n` +
        `  Longer commentary stays in # comments above the attribute.\n\n` +
        `  See docs/arch/architecture.md#justfile-is-the-command-source\n`,
      );
    }
  }
  process.exit(failed ? 2 : 0);
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

  // config-driven exempt (the signposts.yaml `rules.justfile-docs.exempt` slice):
  // exempting both undocumented recipes clears the sample; exempting one leaves one.
  const exemptAllOk = undocumentedRecipes(illegal, ['build', 'bare-recipe']).length === 0;
  const exemptOneOk = (() => {
    const f = undocumentedRecipes(illegal, ['build']);
    return f.length === 1 && f[0].name === 'bare-recipe';
  })();

  const ok = legalOk && illegalOk && exemptAllOk && exemptOneOk;
  console.log(ok ? 'PASS check-justfile-docs' : 'FAIL check-justfile-docs');
  process.exit(ok ? 0 : 1);
}

const args = process.argv.slice(2);
if (args[0] === '--test') selfTest();
else if (args.length) runFiles(args);
else process.exit(0);
