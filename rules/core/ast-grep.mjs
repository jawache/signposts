// rules/core/ast-grep.mjs — ban or require a code shape (native, in-process).
//
// ast-grep is a Rust tool, but it ships a native Node binding (@ast-grep/napi).
// We hand it the reconstructed would-be file AS A STRING and get matches back —
// no subprocess, no temp file — which is exactly what lets it run pre-emptively
// on every edit as well as at commit.
//
// The patterns are FILES: rules/ast-grep/*.yml (so `ast-grep scan` and the test
// runner share one source of truth). The engine auto-discovers them and feeds this
// script a synthetic rule carrying { astgrep: <rule>, lang }. It is never a plain
// `rules:` entry — drop a .yml in the folder and it's picked up.
//
// Contract: kind 'content' → ctx = { path, content, root, phase, exists, readText }.

export async function astGrepHits(content, ruleObj, lang = 'tsx') {
  const { parse, Lang } = await import('@ast-grep/napi');
  const L = { tsx: Lang.Tsx, typescript: Lang.TypeScript, ts: Lang.TypeScript }[lang] ?? Lang.Tsx;
  const root = parse(L, content).root();
  return root.findAll({ rule: ruleObj }).map((m) => `${m.range().start.line + 1}: ${m.text()}`);
}

export default {
  kind: 'content',
  async evaluate(rule, ctx) {
    return astGrepHits(ctx.content, rule.astgrep, rule.lang);
  },
  async test() {
    const r = { any: [{ pattern: '$X ?? new Date($$$)' }, { pattern: '$X ?? new Date' }] };
    const bad = (await astGrepHits('const p = a ?? new Date();', r)).length === 1;
    const good = (await astGrepHits('const p = a || new Date();', r)).length === 0;
    return { name: 'core/ast-grep', pass: bad && good };
  },
};
