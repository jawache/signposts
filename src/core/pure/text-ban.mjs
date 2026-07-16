// src/core/pure/text-ban.mjs — PURE decision: which lines of some text match a banned pattern?
// No IO — the adapter (../text-ban.mjs) supplies the file content and calls this.

export function textBan(content, bans) {
  const lines = content.split('\n');
  const out = [];
  for (const pat of [].concat(bans)) {
    const re = new RegExp(pat);
    lines.forEach((ln, i) => { if (re.test(ln)) out.push(`line ${i + 1}: matches /${pat}/`); });
  }
  return out;
}
