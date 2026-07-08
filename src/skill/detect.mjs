#!/usr/bin/env node
// src/skill/detect.mjs — `signposts detect`: a deterministic read of what languages a
// project actually uses, so setup (and `languages add`) never bundle-guess. JSON out, like
// facts/diff. Two signals: a FILE CENSUS (extensions → languages) and STACK SIGNALS (deps in
// package.json — on Neon, SQL is worth a grammar before a .sql file even exists). No network.

import { readFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkFiles } from '../core/fs.mjs';

const EXT_LANG = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx', '.jsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.html': 'html', '.htm': 'html', '.css': 'css',
  '.astro': 'astro', '.vue': 'vue', '.svelte': 'svelte',
  '.sql': 'sql', '.py': 'python', '.go': 'go', '.rs': 'rust',
  '.rb': 'ruby', '.java': 'java', '.php': 'php',
};
// deps whose PRESENCE implies a language worth a grammar (even before a matching file exists).
const DEP_LANG = {
  astro: 'astro', vue: 'vue', svelte: 'svelte',
  '@neondatabase/serverless': 'sql', 'drizzle-orm': 'sql', postgres: 'sql', pg: 'sql', kysely: 'sql', 'better-sqlite3': 'sql',
};
// tier-0 natives (napi parses out of the box — no grammar install).
const NATIVE = new Set(['typescript', 'tsx', 'javascript', 'html', 'css']);
const SKIP = new Set(['node_modules', '.git', '.signposts', '.work', 'dist', 'build', 'coverage', '.next', '.astro']);

// ── pure core (testable without fs) ───────────────────────────────────────────
export function analyze(files, deps = []) {
  const extensions = {};
  const langs = {};
  const touch = (name, src) => { (langs[name] ||= { files: 0, sources: new Set() }).sources.add(src); };
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (!ext) continue;
    extensions[ext] = (extensions[ext] || 0) + 1;
    const lang = EXT_LANG[ext];
    if (lang) { touch(lang, 'files'); langs[lang].files++; }
  }
  for (const d of deps) { const lang = DEP_LANG[d]; if (lang) touch(lang, 'deps'); }
  const languages = Object.entries(langs)
    .map(([name, v]) => ({ name, native: NATIVE.has(name), files: v.files, sources: [...v.sources].sort() }))
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
  return { extensions, languages, recommend: languages.filter((l) => !l.native).map((l) => l.name) };
}

// ── gather from disk ──────────────────────────────────────────────────────────
function listFiles(root) { return walkFiles(root, { skip: SKIP }); }
function readDeps(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  } catch { return []; }
}
export function detect(root) {
  return { root, ...analyze(listFiles(root), readDeps(root)) };
}

// ── self-test (pure analyze — no fs, no network) ──────────────────────────────
function selfTest() {
  const r = analyze(['src/a.ts', 'src/b.tsx', 'src/c.astro', 'db/schema.ts', 'page.html'], ['astro', '@neondatabase/serverless']);
  const byName = Object.fromEntries(r.languages.map((l) => [l.name, l]));
  const checks = [
    ['counts extensions', r.extensions['.ts'] === 2 && r.extensions['.astro'] === 1],
    ['typescript is native', byName.typescript && byName.typescript.native === true],
    ['astro detected from files + deps', byName.astro && byName.astro.sources.join() === 'deps,files'],
    ['sql detected from Neon dep alone (no .sql file)', byName.sql && byName.sql.files === 0 && byName.sql.sources.join() === 'deps'],
    ['recommend = the non-native ones', JSON.stringify([...r.recommend].sort()) === JSON.stringify(['astro', 'sql'])],
  ];
  const fail = checks.filter(([, ok]) => !ok).map(([n]) => n);
  if (fail.length) { console.error('FAIL detect:\n  ' + fail.join('\n  ')); process.exit(1); }
  console.log(`PASS detect (${checks.length} checks)`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--test')) { selfTest(); process.exit(0); }
  const ti = argv.indexOf('--target');
  const root = resolve(ti >= 0 ? argv[ti + 1] : process.cwd());
  const report = detect(root);
  if (argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
  console.log(`languages in ${root}:`);
  for (const l of report.languages) {
    console.log(`  ${l.name.padEnd(12)} ${l.native ? 'native' : 'needs grammar'}  ${l.files ? `${l.files} file(s)` : ''}  (${l.sources.join(' + ')})`);
  }
  if (report.recommend.length) console.log(`\nAdd with:  ${report.recommend.map((l) => `signposts languages add ${l}`).join('\n           ')}`);
  else console.log('\nAll detected languages are native — nothing to install.');
}
