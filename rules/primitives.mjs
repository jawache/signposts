// rules/primitives.mjs — the core primitives, one per category.
//
// A rule INSTANCE in signposts.yaml names a primitive via `use:` and carries its
// config. Each primitive here exposes:
//   category  — A/B/C/D/E/F/P/G (the eight steering categories)
//   kind      — 'content' | 'path' | 'command' | 'project'  (what the engine feeds it)
//   evaluate(rule, ctx) -> string[]   hits ([] = pass; may be async)
//   test() -> { name, pass }          legal + illegal sample (the per-category proof)
//
// ctx = { file, content, command, root, readText(absPath)->string|null, exists(absPath)->bool }
// Pure cores are exported too, so the self-tests need no filesystem.

import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { escapeRe, matchAny, expandTemplate } from './_util.mjs';

// ── A · ast-grep pattern (declarative, in-process via napi) ───────────────────
async function astGrepHits(content, ruleObj, lang = 'tsx') {
  const { parse, Lang } = await import('@ast-grep/napi');
  const L = { tsx: Lang.Tsx, typescript: Lang.TypeScript, ts: Lang.TypeScript }[lang] ?? Lang.Tsx;
  const root = parse(L, content).root();
  return root.findAll({ rule: ruleObj }).map((m) => `${m.range().start.line + 1}: ${m.text()}`);
}
const astGrepPattern = {
  category: 'A', kind: 'content',
  async evaluate(rule, ctx) { return astGrepHits(ctx.content, rule.astgrep, rule.lang); },
  async test() {
    const r = { any: [{ pattern: '$X ?? new Date($$$)' }, { pattern: '$X ?? new Date' }] };
    const bad = (await astGrepHits('const p = a ?? new Date();', r)).length === 1;
    const good = (await astGrepHits('const p = a || new Date();', r)).length === 0;
    return { name: 'A ast-grep-pattern', pass: bad && good };
  },
};

// ── B · correlation across nodes (parser-as-library) ──────────────────────────
export async function exportedNames(content) {
  const { parse, Lang } = await import('@ast-grep/napi');
  const root = parse(Lang.Tsx, content).root();
  const out = new Set();
  for (const p of ['export function $N($$$) { $$$ }', 'export class $N { $$$ }', 'export const $N = $V']) {
    for (const m of root.findAll(p)) { const n = m.getMatch('N'); if (n) out.add(n.text()); }
  }
  return [...out];
}
export function unreferenced(names, siblingText) {
  return names.filter((n) => !new RegExp(`\\b${escapeRe(n)}\\b`).test(siblingText));
}
const symbolsInSibling = {
  category: 'B', kind: 'content',
  async evaluate(rule, ctx) {
    const sibling = expandTemplate(rule.sibling, ctx.file);
    const text = ctx.readText(join(ctx.root, sibling));
    if (text == null) return [`sibling test not found: ${sibling}`];
    const names = await exportedNames(ctx.content);
    return unreferenced(names, text).map((n) => `exported '${n}' is never referenced in ${sibling}`);
  },
  async test() {
    const names = await exportedNames('export function foo(){}\nexport const bar = () => 1;');
    const got = names.includes('foo') && names.includes('bar');
    const flagged = unreferenced(names, 'test(foo)');           // bar unreferenced
    return { name: 'B symbols-in-sibling', pass: got && flagged.length === 1 && flagged[0] === 'bar' };
  },
};

// ── C · path shape (no content parse) ─────────────────────────────────────────
const siblingExists = {
  category: 'C', kind: 'path',
  evaluate(rule, ctx) {
    const sibling = expandTemplate(rule.sibling, ctx.file);
    return ctx.exists(join(ctx.root, sibling)) ? [] : [`required sibling missing: ${sibling}`];
  },
  test() {
    const have = new Set(['/r/a/x.ts', '/r/a/x.test.ts']);
    const ctx = (file) => ({ file, root: '/r', exists: (p) => have.has(p) });
    const rule = { sibling: '{path}.test.ts' };
    const legal = this.evaluate(rule, ctx('a/x.ts')).length === 0;     // x.test.ts exists
    const illegal = this.evaluate(rule, ctx('a/y.ts')).length === 1;   // y.test.ts missing
    return { name: 'C sibling-exists', pass: legal && illegal };
  },
};

// ── D · structured-file invariant (JSON) ──────────────────────────────────────
export function jsonInvariant(jsonText, assert) {
  let obj; try { obj = JSON.parse(jsonText); } catch { return []; }
  let node = obj;
  for (const k of (assert.path || '').split('.').filter(Boolean)) node = node?.[k];
  if (!node || typeof node !== 'object') return [];
  const out = [];
  if (assert.keysPrefixedWith != null) {
    for (const k of Object.keys(node)) {
      if (!k.startsWith(assert.keysPrefixedWith)) out.push(`"${assert.path}.${k}" must be prefixed "${assert.keysPrefixedWith}"`);
    }
  }
  return out;
}
const jsonInvariantPrim = {
  category: 'D', kind: 'content',
  evaluate(rule, ctx) { return jsonInvariant(ctx.content, rule.assert); },
  test() {
    const a = { path: 'scripts', keysPrefixedWith: '//' };
    const legal = jsonInvariant('{"scripts":{"//":"see justfile"}}', a).length === 0;
    const illegal = jsonInvariant('{"scripts":{"//":"x","dev":"run"}}', a).length === 1;
    return { name: 'D json-invariant', pass: legal && illegal };
  },
};

// ── E · text ban (regex in prose / content) ───────────────────────────────────
export function textBan(content, bans) {
  const lines = content.split('\n');
  const out = [];
  for (const pat of [].concat(bans)) {
    const re = new RegExp(pat);
    lines.forEach((ln, i) => { if (re.test(ln)) out.push(`line ${i + 1}: matches /${pat}/`); });
  }
  return out;
}
const textBanPrim = {
  category: 'E', kind: 'content',
  evaluate(rule, ctx) { return textBan(ctx.content, rule.ban); },
  test() {
    const legal = textBan('all good here', ['\\bTODO\\b']).length === 0;
    const illegal = textBan('x\nleft a TODO here', ['\\bTODO\\b']).length === 1;
    return { name: 'E text-ban', pass: legal && illegal };
  },
};

// ── F · command guard (operates on a Bash command string) ─────────────────────
export function bannedCommand(command, bans) {
  return [].concat(bans).filter((pat) => new RegExp(pat).test(command)).map((pat) => `command matches banned /${pat}/`);
}
const commandGuard = {
  category: 'F', kind: 'command',
  evaluate(rule, ctx) { return bannedCommand(ctx.command, rule.ban); },
  test() {
    const bans = ['git\\s+checkout\\s+--', 'git\\s+reset\\s+--hard'];
    const legal = bannedCommand('git status', bans).length === 0;
    const illegal = bannedCommand('git checkout -- src/x.ts', bans).length === 1;
    return { name: 'F command-guard', pass: legal && illegal };
  },
};

// ── P · protected path (content-free edit block) ──────────────────────────────
const protectedPath = {
  category: 'P', kind: 'path',
  evaluate(rule, ctx) {
    return matchAny(ctx.file, rule.deny) ? [`'${ctx.file}' is a protected path (do not edit directly)`] : [];
  },
  test() {
    const rule = { deny: ['src/generated/**', 'legacy/**'] };
    const legal = this.evaluate(rule, { file: 'src/app/x.ts' }).length === 0;
    const illegal = this.evaluate(rule, { file: 'src/generated/api.ts' }).length === 1;
    return { name: 'P protected-path', pass: legal && illegal };
  },
};

// ── G · tool gate (run an external tool; commit/push only) ─────────────────────
const toolGate = {
  category: 'G', kind: 'project',
  evaluate(rule, ctx) {
    const r = spawnSync('bash', ['-lc', rule.run], { cwd: ctx.root, encoding: 'utf8' });
    if (r.status === 0) return [];
    return [`tool-gate failed (exit ${r.status}): ${rule.run}\n${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n')}`];
  },
  test() {
    const root = process.cwd();
    const legal = this.evaluate({ run: 'true' }, { root }).length === 0;
    const illegal = this.evaluate({ run: 'exit 3' }, { root }).length === 1;
    return { name: 'G tool-gate', pass: legal && illegal };
  },
};

export const primitives = {
  'ast-grep-pattern': astGrepPattern,
  'symbols-in-sibling': symbolsInSibling,
  'sibling-exists': siblingExists,
  'json-invariant': jsonInvariantPrim,
  'text-ban': textBanPrim,
  'command-guard': commandGuard,
  'protected-path': protectedPath,
  'tool-gate': toolGate,
};

export async function selfTestAll() {
  const results = [];
  for (const p of Object.values(primitives)) results.push(await p.test());
  return results;
}
