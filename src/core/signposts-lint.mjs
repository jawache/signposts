// src/core/signposts-lint.mjs — ADAPTER: lint the signposts config file itself. A content rule
// scoped to signposts.yaml: it PARSES the would-be file, then hands the parsed doc to the pure
// linter (./pure/signposts-lint.mjs), which blocks if any sign/rule is missing a required field.
//
// Config:  require: [description]     # fields every sign & rule must carry non-empty (default [description])
// Contract: kind 'content' → ctx = { path, content, ... }. Scope it with `on: ["signposts.yaml"]`.

import { parse as parseYaml } from 'yaml';
import { lint } from './pure/signposts-lint.mjs';
export { lint };

export default {
  kind: 'content',
  evaluate(rule, ctx) {
    let doc;
    try { doc = parseYaml(ctx.content); }
    catch (e) { return [`not valid YAML: ${String(e && e.message || e).split('\n')[0]}`]; }
    return lint(doc, rule.require || ['description']);
  },
  test() {
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
