#!/usr/bin/env node
// src/cli/languages.mjs — `signposts languages …`: the deterministic mechanics for ast-grep
// grammars. The JUDGEMENT (which grammars, and how to get an unpublished one) lives in the
// `/signposts setup` skill — these are the steps it runs.
//
//   signposts languages list
//       show native (no install) + installed @ast-grep/lang-* + sgconfig.yml customLanguages
//   signposts languages add <lang> [--target <dir>]
//       install a PREBUILT grammar: npm install @ast-grep/lang-<lang>. Resolved by import at
//       runtime (its binary lives in node_modules). Fails clearly if none is published.
//   signposts languages register <lang> --library-path <path> --ext <ext>[,<ext>] [--expando <c>]
//       declare a CUSTOM grammar you built (tree-sitter build) in sgconfig.yml customLanguages —
//       the engine registers it, and the ast-grep CLI can use it too.

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { editYaml } from './install.mjs';
import { nativeLanguages, customLanguages } from '../core/languages.mjs';

// A grammar name becomes an npm package name and a config key — validate before either.
export function assertLangName(lang) {
  if (!/^[a-z][a-z0-9-]*$/.test(lang || '')) {
    throw new Error(`invalid language name '${lang}' — expected lowercase letters, digits, and dashes (e.g. astro, sql).`);
  }
}

function installedGrammars(target) {
  try { return readdirSync(join(target, 'node_modules', '@ast-grep')).filter((d) => d.startsWith('lang-')).map((d) => d.slice(5)); }
  catch { return []; }
}

// Install a PREBUILT @ast-grep/lang-<lang> package (its binary is resolved by import at runtime).
export function languagesAdd({ lang, target = process.cwd(), log = console.log }) {
  assertLangName(lang);
  log(`• grammar: npm install @ast-grep/lang-${lang}`);
  const r = spawnSync('npm', ['install', `@ast-grep/lang-${lang}`], { cwd: target, stdio: 'inherit' });
  if (r.status === 0) { log(`  ✓ ${lang} installed — a rule with \`language: ${lang}\` now resolves.`); return true; }
  log(`  ! no published @ast-grep/lang-${lang} (sql/python/go/rust have one; astro/vue/svelte don't).`);
  log(`    For an unpublished grammar: build it and register it —`);
  log(`      npm install -g tree-sitter-cli`);
  log(`      git clone <the tree-sitter-${lang} grammar> && cd tree-sitter-${lang} && tree-sitter build --output ../grammars/${lang}.so`);
  log(`      signposts languages register ${lang} --library-path grammars/${lang}.so --ext ${lang}`);
  return false;
}

// Declare a CUSTOM grammar (a built .so) in sgconfig.yml customLanguages — comment-preserving.
// `languageSymbol` defaults (in napi) to `tree_sitter_<lang>`; pass it when the grammar's internal
// symbol differs from the language name.
export function languagesRegister({ lang, libraryPath, extensions, expandoChar, languageSymbol, target = process.cwd(), log = console.log }) {
  assertLangName(lang);
  if (!libraryPath) throw new Error('register needs --library-path <path to the built .so/.dylib>');
  const exts = (Array.isArray(extensions) ? extensions : String(extensions || lang).split(',')).map((e) => e.replace(/^\./, '')).filter(Boolean);
  editYaml(join(target, 'sgconfig.yml'), (doc) => {
    if (doc.getIn(['customLanguages']) == null) doc.setIn(['customLanguages'], doc.createNode({}));
    doc.setIn(['customLanguages', lang], {
      libraryPath, extensions: exts,
      ...(languageSymbol ? { languageSymbol } : {}),
      ...(expandoChar ? { expandoChar } : {}),
    });
  });
  log(`• sgconfig.yml: registered custom grammar '${lang}' → ${libraryPath} (${exts.join(', ')})`);
  if (!existsSync(join(target, libraryPath))) log(`  ⚠ ${libraryPath} doesn't exist yet — build it: \`tree-sitter build --output ${libraryPath}\`.`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--test')) { await selfTest(); process.exit(0); }
  const o = { target: process.cwd(), positionals: [], libraryPath: null, ext: null, expando: null, symbol: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') o.target = resolve(argv[++i]);
    else if (a === '--library-path') o.libraryPath = argv[++i];
    else if (a === '--ext') o.ext = argv[++i];
    else if (a === '--expando') o.expando = argv[++i];
    else if (a === '--symbol') o.symbol = argv[++i];
    else if (!a.startsWith('-')) o.positionals.push(a);
  }
  const [sub, lang] = o.positionals;
  try {
    if (sub === 'list') {
      console.log(`native (no install):  ${(await nativeLanguages()).join(', ')}`);
      const pkgs = installedGrammars(o.target);
      console.log(`prebuilt installed:   ${pkgs.length ? pkgs.join(', ') : '(none — signposts languages add <lang>)'}`);
      const custom = Object.keys(customLanguages(o.target));
      console.log(`custom (sgconfig):    ${custom.length ? custom.join(', ') : '(none — signposts languages register <lang> …)'}`);
    } else if (sub === 'add') {
      if (!lang) { console.error('usage: signposts languages add <lang>'); process.exit(1); }
      process.exit(languagesAdd({ lang, target: o.target }) ? 0 : 1);
    } else if (sub === 'register') {
      if (!lang) { console.error('usage: signposts languages register <lang> --library-path <path> --ext <ext>'); process.exit(1); }
      languagesRegister({ lang, libraryPath: o.libraryPath, extensions: o.ext, expandoChar: o.expando, languageSymbol: o.symbol, target: o.target });
    } else {
      console.error('usage: signposts languages <list|add|register>'); process.exit(1);
    }
  } catch (e) { console.error(`signposts languages: ${e.message}`); process.exit(1); }
}

// ── self-test (register writes sgconfig, comment-preserving; validation) ──────
async function selfTest() {
  const { mkdtempSync, writeFileSync, readFileSync: rf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'sg-lang-'));
  writeFileSync(join(dir, 'sgconfig.yml'), 'ruleDirs:\n  - rules/ast-grep   # keep this comment\ncustomLanguages: {}\n');
  const checks = [];
  languagesRegister({ lang: 'astro', libraryPath: 'grammars/astro.so', extensions: '.astro', target: dir, log: () => {} });
  const after = rf(join(dir, 'sgconfig.yml'), 'utf8');
  checks.push(['register writes customLanguages', /customLanguages:[\s\S]*astro:[\s\S]*grammars\/astro\.so/.test(after)]);
  checks.push(['strips the leading dot from the extension', /extensions:\s*\[?\s*["']?astro/.test(after)]);
  checks.push(['preserves comments', /keep this comment/.test(after)]);
  checks.push(['reads it back', 'astro' in customLanguages(dir)]);
  languagesRegister({ lang: 'vue', libraryPath: 'grammars/vue.so', extensions: 'vue', target: dir, log: () => {} });
  checks.push(['appends a second custom grammar', Object.keys(customLanguages(dir)).sort().join(',') === 'astro,vue']);
  let rejected = false; try { assertLangName('../evil'); } catch { rejected = true; }
  checks.push(['rejects an unsafe name', rejected]);
  const fail = checks.filter(([, ok]) => !ok).map(([n]) => n);
  if (fail.length) { console.error('FAIL languages-cli:\n  ' + fail.join('\n  ')); process.exit(1); }
  console.log(`PASS languages-cli (${checks.length} checks)`);
}
