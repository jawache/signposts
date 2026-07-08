// src/core/languages.mjs — the language registry (C).
//
// A rule's `language:` resolves to something napi's `parse()` accepts:
//   • TIER-0 native — html · css · javascript · typescript · tsx — a `Lang` enum member,
//     always available. Free; no install.
//   • CUSTOM — declared in the project's `sgconfig.yml` `customLanguages:` (name → libraryPath +
//     extensions). The engine reads that file and hands the entry to napi's
//     registerDynamicLanguage — the SAME file the ast-grep CLI reads. This is how a hand-built
//     grammar (astro/vue/svelte, which have no npm package) gets in.
//   • PREBUILT — a published `@ast-grep/lang-<name>` package (sql, python, go, rust…). Its
//     compiled binary lives in node_modules, so it's resolved by importing the package at
//     runtime (its libraryPath is machine-specific — never committed).
//   • UNKNOWN — a real, named error. Never the old silent → Tsx.
//
// `registerDynamicLanguage` is safe to call per-language (verified), so registration is lazy +
// idempotent (guarded by a Set).

import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

let _tier0 = null;
const _registered = new Set();   // dynamic languages registered this process

export async function tier0() {
  if (_tier0) return _tier0;
  const { Lang } = await import('@ast-grep/napi');
  _tier0 = {
    html: Lang.Html, css: Lang.Css,
    javascript: Lang.JavaScript, js: Lang.JavaScript,
    typescript: Lang.TypeScript, ts: Lang.TypeScript,
    tsx: Lang.Tsx, jsx: Lang.Tsx,   // napi has no separate Jsx grammar; Tsx is the superset
  };
  return _tier0;
}
export async function nativeLanguages() { return Object.keys(await tier0()); }

// The `customLanguages:` block from the project's sgconfig.yml (empty if none / unreadable).
export function customLanguages(root) {
  if (!root) return {};
  try {
    const sg = parseYaml(readFileSync(join(root, 'sgconfig.yml'), 'utf8')) || {};
    return (sg.customLanguages && typeof sg.customLanguages === 'object') ? sg.customLanguages : {};
  } catch { return {}; }
}

// Resolve a language name to a `parse()` argument, or throw the honest error.
export async function resolveLang(name = 'tsx', { root } = {}) {
  const t0 = await tier0();
  if (name in t0) return t0[name];
  if (_registered.has(name)) return name;
  const { registerDynamicLanguage } = await import('@ast-grep/napi');

  // 1. a custom grammar declared in sgconfig.yml (a hand-built .so — astro/vue/svelte)
  const custom = customLanguages(root)[name];
  if (custom && custom.libraryPath) {
    const libraryPath = isAbsolute(custom.libraryPath) ? custom.libraryPath : join(root, custom.libraryPath);
    try { registerDynamicLanguage({ [name]: { ...custom, libraryPath } }); _registered.add(name); return name; }
    catch (e) {
      throw new Error(`ast-grep language '${name}' is declared in sgconfig.yml but its grammar failed to load (${e.message}). Rebuild it: \`tree-sitter build --output ${custom.libraryPath}\`.`);
    }
  }

  // 2. a prebuilt @ast-grep/lang-<name> npm package (its binary lives in node_modules)
  try { const mod = await import(`@ast-grep/lang-${name}`); registerDynamicLanguage({ [name]: mod.default ?? mod }); _registered.add(name); return name; }
  catch { /* not installed → honest error below */ }

  // 3. honest error — never a silent fall-through to Tsx
  throw new Error(
    `unknown ast-grep language: '${name}'. Native: ${Object.keys(t0).join(', ')}. ` +
    `Install a published grammar with \`signposts languages add ${name}\`, or (for astro/vue/svelte and other ` +
    `unpublished grammars) build it with tree-sitter and add it to sgconfig.yml customLanguages.`,
  );
}

// ── self-test (tier-0 resolution + the honest error) ──────────────────────────
export async function selfTest() {
  const t0 = await tier0();
  const checks = [
    ['tier-0 has html/css/js/ts/tsx', ['html', 'css', 'javascript', 'typescript', 'tsx'].every((k) => k in t0)],
    ['tsx resolves to a Lang', (await resolveLang('tsx')) === t0.tsx],
    ['html resolves (was unmapped before)', (await resolveLang('html')) === t0.html],
    ['css resolves (was unmapped before)', (await resolveLang('css')) === t0.css],
    ['js alias resolves to JavaScript', (await resolveLang('js')) === t0.javascript],
    ['default is tsx', (await resolveLang()) === t0.tsx],
    ['unknown throws, naming languages add + sgconfig', await threw('nope-lang', /languages add nope-lang[\s\S]*sgconfig/)],
  ];
  const fail = checks.filter(([, ok]) => !ok).map(([n]) => n);
  if (fail.length) { console.error('FAIL languages:\n  ' + fail.join('\n  ')); process.exit(1); }
  console.log(`PASS languages (${checks.length} checks)`);
}
async function threw(name, re) {
  try { await resolveLang(name); return false; } catch (e) { return re.test(e.message); }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--test') selfTest();
