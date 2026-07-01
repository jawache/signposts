#!/usr/bin/env node
// cli/signposts.mjs — the `npx signposts` entry point (deterministic; no judgement).
//
//   npx signposts                 scaffold the core pack into the current repo + arm it
//   npx signposts refresh         pull pack updates (three-way merge; keeps your edits)
//   npx signposts --help
//
// Flags:  --target <dir>   operate on <dir> instead of the cwd
//         --no-activate    scaffold without running `npm install` (arm it yourself)
//
// The skill side of Signposts (reflect · propagate · install) is the /signposts skill —
// this CLI is only the parts that don't need judgement.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold } from './scaffold.mjs';
import { refresh } from './refresh.mjs';

// packRoot = the package that holds the core pack. Running from this repo it's the repo
// root; installed via npm it's node_modules/signposts. Either way: one level up from cli/.
const PACK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parse(argv) {
  const opts = { cmd: null, target: process.cwd(), activate: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') opts.target = resolve(argv[++i]);
    else if (a === '--no-activate') opts.activate = false;
    else if (a === '--help' || a === '-h') opts.cmd = 'help';
    else if (!opts.cmd && !a.startsWith('-')) opts.cmd = a;
  }
  return opts;
}

function help() {
  console.log(`signposts — keep your AI coding agent on the rails.

Usage:
  npx signposts                 scaffold the core pack into this repo and arm the gate
  npx signposts refresh         pull updates for installed packs (keeps your local edits)
  npx signposts --help

Options:
  --target <dir>   operate on <dir> instead of the current directory
  --no-activate    scaffold without running \`npm install\`

Judgement lives in the /signposts skill (reflect · propagate · install).`);
}

const opts = parse(process.argv.slice(2));
try {
  if (opts.cmd === 'help') help();
  else if (opts.cmd === 'refresh') refresh({ packRoot: PACK_ROOT, target: opts.target });
  else if (!opts.cmd || opts.cmd === 'scaffold') scaffold({ packRoot: PACK_ROOT, target: opts.target, activate: opts.activate });
  else { console.error(`Unknown command: ${opts.cmd}\n`); help(); process.exit(1); }
} catch (e) {
  console.error(`signposts: ${e?.stack || e}`);
  process.exit(1);
}
