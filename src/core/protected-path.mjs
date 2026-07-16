// src/core/protected-path.mjs — ADAPTER: block any hand-edit of a protected path.
// The decision is pure (./pure/protected-path.mjs); this wires it to the engine's path contract.
//
// Config:  deny: ["**/*.generated.ts", "vendor/**"]   (path is the whole rule)
// Contract: kind 'path' → ctx = { path, root, exists, readText }.

import { protectedPathHits } from './pure/protected-path.mjs';

export default {
  kind: 'path',
  evaluate(rule, ctx) { return protectedPathHits(ctx.path, rule.deny); },
  test() {
    const rule = { deny: ['src/generated/**', 'legacy/**'] };
    const legal = this.evaluate(rule, { path: 'src/app/x.ts' }).length === 0;
    const illegal = this.evaluate(rule, { path: 'src/generated/api.ts' }).length === 1;
    return { name: 'core/protected-path', pass: legal && illegal };
  },
};
