// src/core/json-invariant.mjs — ADAPTER: a structured (JSON) file must hold an invariant.
// The decision is pure (./pure/json-invariant.mjs); this wires it to the engine's content contract.
//
// Config:  assert: { path: "scripts", keysPrefixedWith: "//" }   (or a LIST of asserts)
// Contract: kind 'content' → ctx = { path, content, root, exists, readText }.

import { jsonInvariant } from './pure/json-invariant.mjs';
export { jsonInvariant };

export default {
  kind: 'content',
  evaluate(rule, ctx) { return jsonInvariant(ctx.content, rule.assert); },
  test() {
    const a = { path: 'scripts', keysPrefixedWith: '//' };
    const legal = jsonInvariant('{"scripts":{"//":"see justfile"}}', a).length === 0;
    const illegal = jsonInvariant('{"scripts":{"//":"x","dev":"run"}}', a).length === 1;
    return { name: 'core/json-invariant', pass: legal && illegal };
  },
};
