// rules/core/text-ban.mjs — ban a word or pattern in text/prose.
//
// A plain regex over the content, line by line. For code shapes prefer
// core/ast-grep (it won't false-match a string or comment); text-ban is for
// prose, docs, config where a literal/regex match is what you want.
//
// Config:  ban: "\\bTODO\\b"   (a regex, or a list of regexes)
// Contract: kind 'content' → ctx = { path, content, root, exists, readText }.

export function textBan(content, bans) {
  const lines = content.split('\n');
  const out = [];
  for (const pat of [].concat(bans)) {
    const re = new RegExp(pat);
    lines.forEach((ln, i) => { if (re.test(ln)) out.push(`line ${i + 1}: matches /${pat}/`); });
  }
  return out;
}

export default {
  kind: 'content',
  evaluate(rule, ctx) { return textBan(ctx.content, rule.ban); },
  test() {
    const legal = textBan('all good here', ['\\bTODO\\b']).length === 0;
    const illegal = textBan('x\nleft a TODO here', ['\\bTODO\\b']).length === 1;
    return { name: 'core/text-ban', pass: legal && illegal };
  },
};
