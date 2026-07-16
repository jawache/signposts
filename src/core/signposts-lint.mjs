// src/core/signposts-lint.mjs — lint the signposts config file itself. A content rule scoped to
// signposts.yaml: it parses the would-be file and blocks if it's MALFORMED or if any sign/rule is
// missing a REQUIRED field (default: `description`, so every entry carries a human summary). The
// dogfood guard on the guardrails' own manifest — it keeps the file well-formed and self-describing.
//
// Config:  require: [description]     # fields every sign & rule must carry non-empty (default [description])
// Contract: kind 'content' → ctx = { path, content, ... }. Scope it with `on: ["signposts.yaml"]`.

import { parse as parseYaml } from 'yaml';

// Walk a parsed doc's signs & rules (bundle-first AND section-first) → the required-field hits.
export function lint(doc, required = ['description']) {
  if (!doc || typeof doc !== 'object') return ['signposts file is empty or not a mapping'];
  const need = [].concat(required);
  const hits = [];
  const check = (kind, ns, entry, i) => {
    const id = entry && entry.id;
    const where = `${kind} ${ns ? `${ns}/` : ''}${id || `#${i + 1}`}`;
    if (!entry || typeof entry !== 'object') { hits.push(`${where}: not a mapping`); return; }
    if (!id) hits.push(`${where}: missing an id`);
    if (kind === 'rule' && !entry.use) hits.push(`${where}: a rule must name a script with use:`);
    for (const f of need) {
      const v = entry[f];
      if (v == null || String(v).trim() === '') hits.push(`${where}: missing ${f}`);
    }
  };
  const RESERVED = new Set(['project', 'config', 'signs', 'rules', 'settings', 'advisory', 'packs', 'install', 'bundles']);
  const walk = (ns, block) => {
    if (!block || typeof block !== 'object') return;
    // current shape: a `signposts:` list of typed signposts.
    (Array.isArray(block.signposts) ? block.signposts : []).forEach((e, i) => {
      const kind = e && e.type === 'sign' ? 'sign' : e && e.type === 'rule' ? 'rule' : null;
      if (!kind) hits.push(`signpost ${ns}/${(e && e.id) || `#${i + 1}`}: missing or unknown \`type\` (expected sign | rule)`);
      else check(kind, ns, e, i);
    });
    // legacy grouped-inside-a-bundle.
    if (Array.isArray(block.signs)) block.signs.forEach((e, i) => check('sign', ns, e, i));
    if (Array.isArray(block.rules)) block.rules.forEach((e, i) => check('rule', ns, e, i));
  };
  // current shape: every non-reserved top-level key is a bundle.
  for (const [ns, b] of Object.entries(doc)) {
    if (RESERVED.has(ns) || !b || typeof b !== 'object' || Array.isArray(b)) continue;
    walk(ns, b);
  }
  // legacy `bundles:` wrapper.
  if (doc.bundles && typeof doc.bundles === 'object' && !Array.isArray(doc.bundles)) {
    for (const [ns, b] of Object.entries(doc.bundles)) walk(ns, b);
  }
  // legacy section-first: signs.<ns>[] / rules.<ns>[].
  for (const kind of ['signs', 'rules']) {
    const g = doc[kind];
    if (g && typeof g === 'object' && !Array.isArray(g)) {
      for (const [ns, list] of Object.entries(g)) if (Array.isArray(list)) list.forEach((e, i) => check(kind.slice(0, -1), ns, e, i));
    }
  }
  return hits;
}

export default {
  kind: 'content',
  evaluate(rule, ctx) {
    let doc;
    try { doc = parseYaml(ctx.content); }
    catch (e) { return [`not valid YAML: ${String(e && e.message || e).split('\n')[0]}`]; }
    return lint(doc, rule.require || ['description']);
  },
  test() {
    // current shape: a top-level bundle with a typed `signposts:` list.
    const good = 'mybundle:\n  title: T\n  summary: S\n  signposts:\n    - type: sign\n      id: s\n      description: a sign\n      on: ["x"]\n      text: hi\n    - type: rule\n      id: r\n      description: a rule\n      use: core/protected-path\n      deny: ["y"]\n';
    const noDesc = 'mybundle:\n  signposts:\n    - type: rule\n      id: r\n      use: core/protected-path\n      deny: ["y"]\n';
    const noUse = 'mybundle:\n  signposts:\n    - type: rule\n      id: r\n      description: a rule\n';
    const noType = 'mybundle:\n  signposts:\n    - id: r\n      description: a thing\n';
    const broken = 'mybundle: [oops\n';
    const legacy = 'bundles:\n  local:\n    rules:\n      - id: r\n        description: ok\n        use: core/x\n';
    const ev = (content) => this.evaluate({}, { content });
    const pass = ev(good).length === 0
      && ev(noDesc).some((h) => /missing description/.test(h))
      && ev(noUse).some((h) => /must name a script/.test(h))
      && ev(noType).some((h) => /unknown `type`/.test(h))
      && ev(broken).some((h) => /not valid YAML/.test(h))
      && ev(legacy).length === 0                                     // legacy shape still lints
      && this.evaluate({ require: ['description', 'message'] }, { content: good }).some((h) => /missing message/.test(h));
    return { name: 'core/signposts-lint', pass };
  },
};
