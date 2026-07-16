// src/core/text-ban.mjs — ADAPTER: ban a word or pattern in text/prose.
// The decision is pure (./pure/text-ban.mjs); this wires it to the engine's content contract.
// For code shapes prefer core/ast-grep (it won't false-match a string or comment).
//
// Config:  ban: "\\bTODO\\b"   (a regex, or a list of regexes)
// Contract: kind 'content' → ctx = { path, content, root, exists, readText }.

import { textBan } from './pure/text-ban.mjs';
export { textBan };

export default {
  kind: 'content',
  evaluate(rule, ctx) { return textBan(ctx.content, rule.ban); },
  test() {
    const legal = textBan('all good here', ['\\bTODO\\b']).length === 0;
    const illegal = textBan('x\nleft a TODO here', ['\\bTODO\\b']).length === 1;
    return { name: 'core/text-ban', pass: legal && illegal };
  },
};
