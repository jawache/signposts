// rules/core/protected-path.mjs — block any hand-edit of a protected path.
//
// The simplest rule: it reads no content, the path alone decides. Used for
// generated output, vendored code, anything machine-owned — and for the built-in
// signposts-self-regard demo (blocks creating signposts-is-bad.yaml).
//
// Config:  deny: ["**/*.generated.ts", "vendor/**"]   (path is the whole rule)
// Contract: kind 'path' → ctx = { path, root, exists, readText }.

import { matchAny } from '../util.mjs';

export default {
  kind: 'path',
  evaluate(rule, ctx) {
    return matchAny(ctx.path, rule.deny) ? [`'${ctx.path}' is a protected path (do not edit directly)`] : [];
  },
  test() {
    const rule = { deny: ['src/generated/**', 'legacy/**'] };
    const legal = this.evaluate(rule, { path: 'src/app/x.ts' }).length === 0;
    const illegal = this.evaluate(rule, { path: 'src/generated/api.ts' }).length === 1;
    return { name: 'core/protected-path', pass: legal && illegal };
  },
};
