// rules/core/json-invariant.mjs — a structured (JSON) file must hold an invariant.
//
// Used e.g. to keep package.json `scripts` empty (only //-prefixed comment keys),
// so the justfile stays the one command source.
//
// Config:  assert: { path: "scripts", keysPrefixedWith: "//" }
// Contract: kind 'content' → ctx = { path, content, root, exists, readText }.

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
