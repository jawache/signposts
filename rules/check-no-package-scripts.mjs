#!/usr/bin/env node
// rules/check-no-package-scripts.mjs — enforces ADR 0009.
//
// The justfile is the single source of truth for commands. package.json
// `scripts` is intentionally empty — only `//`-prefixed comment keys are
// allowed (the pointer to the justfile). Any real script key is a second home
// for commands (and a route around dotenvx env loading), so it fails here.
//
// Usage:  node rules/check-no-package-scripts.mjs <package.json> [...]  (exit 2)
//         node rules/check-no-package-scripts.mjs --test                (self-test)

import { readFileSync } from 'node:fs';

// Pure: returns offending script keys (anything not a `//`-prefixed comment).
export function offendingKeys(jsonText) {
  let pkg;
  try { pkg = JSON.parse(jsonText); } catch { return []; }
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object') return [];
  return Object.keys(scripts).filter((k) => !k.startsWith('//'));
}

function runFiles(files) {
  let failed = false;
  for (const f of files) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const bad = offendingKeys(text);
    if (bad.length) {
      failed = true;
      const lineOf = (k) => text.slice(0, text.indexOf(`"${k}"`)).split('\n').length;
      process.stderr.write(
        `\n\x1b[31m✗ package.json scripts must be empty (ADR 0009)\x1b[0m\n` +
        `  File: ${f}\n` +
        bad.map((k) => `    • "${k}"  (line ${lineOf(k)})`).join('\n') + `\n\n` +
        `  The justfile is the single source of truth for commands. Move this\n` +
        `  into a justfile recipe (env-dependent commands go through the \`dx\`\n` +
        `  helper). Only \`//\`-prefixed comment keys are allowed in scripts.\n\n` +
        `  See docs/arch/architecture.md#justfile-is-the-command-source\n`,
      );
    }
  }
  process.exit(failed ? 2 : 0);
}

function selfTest() {
  const onlyComment = '{"scripts":{"//":"see justfile"}}';
  const hasReal = '{"scripts":{"//":"x","dev":"astro dev"}}';
  const noScripts = '{"name":"x"}';
  const ok =
    offendingKeys(onlyComment).length === 0 &&
    JSON.stringify(offendingKeys(hasReal)) === '["dev"]' &&
    offendingKeys(noScripts).length === 0;
  console.log(ok ? 'PASS check-no-package-scripts' : 'FAIL check-no-package-scripts');
  process.exit(ok ? 0 : 1);
}

const args = process.argv.slice(2);
if (args[0] === '--test') selfTest();
else if (args.length) runFiles(args);
else process.exit(0);
