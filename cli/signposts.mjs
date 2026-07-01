#!/usr/bin/env node
// cli/signposts.mjs — the `npx signposts` entry point (deterministic; no judgement).
//
//   npx signposts                 scaffold the core pack into the current repo + arm it
//   npx signposts install <src> [ns]   install a pack from git / npm / a local repo
//   npx signposts refresh         pull pack updates (three-way merge; keeps your edits)
//   npx signposts --help
//
// Flags:  --target <dir>   operate on <dir> instead of the cwd
//         --no-activate    scaffold without running `npm install` (arm it yourself)
//
// The judgement side (reflect · propagate · the interactive install picker) is the
// /signposts skill; this CLI is the deterministic parts it leans on.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold } from './scaffold.mjs';
import { refresh } from './refresh.mjs';
import { installPack } from './install.mjs';

// packRoot = the package that holds the core pack. Running from this repo it's the repo
// root; installed via npm it's node_modules/signposts. Either way: one level up from cli/.
const PACK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parse(argv) {
  const opts = { cmd: null, target: process.cwd(), activate: true, args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') opts.target = resolve(argv[++i]);
    else if (a === '--no-activate') opts.activate = false;
    else if (a === '--help' || a === '-h') opts.cmd = 'help';
    else if (!opts.cmd && !a.startsWith('-')) opts.cmd = a;
    else if (!a.startsWith('-')) opts.args.push(a);          // positional args after the command
  }
  return opts;
}

function help() {
  console.log(`signposts — keep your AI coding agent on the rails.

Usage:
  npx signposts                       scaffold the core pack into this repo and arm the gate
  npx signposts install <src> [ns]    install a pack from git / npm / a local repo
                                      (github:you/neon · @acme/guardrails · ./hub)
  npx signposts refresh               pull updates for installed packs (keeps your edits)
  npx signposts --help

Options:
  --target <dir>   operate on <dir> instead of the current directory
  --no-activate    scaffold without running \`npm install\`

Judgement lives in the /signposts skill (reflect · propagate · install).`);
}

const opts = parse(process.argv.slice(2));
try {
  if (opts.cmd === 'help') help();
  else if (opts.cmd === 'install') {
    if (!opts.args[0]) { console.error('usage: npx signposts install <source> [namespace]'); process.exit(1); }
    installPack({ source: opts.args[0], namespace: opts.args[1], target: opts.target });
  }
  else if (opts.cmd === 'refresh') refresh({ packRoot: PACK_ROOT, target: opts.target });
  else if (!opts.cmd || opts.cmd === 'scaffold') scaffold({ packRoot: PACK_ROOT, target: opts.target, activate: opts.activate });
  else { console.error(`Unknown command: ${opts.cmd}\n`); help(); process.exit(1); }
} catch (e) {
  console.error(`signposts: ${e?.stack || e}`);
  process.exit(1);
}
