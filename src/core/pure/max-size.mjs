// src/core/pure/max-size.mjs — PURE decisions for the byte-budget rule: parse a size, and judge a
// set of files against per-glob budgets. No IO — the adapter (../max-size.mjs) walks the tree and
// stats the files, then calls overBudget with the [{ path, bytes }] it collected.

const UNITS = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };

// "200KB" | "1.5 MB" | 4096 → bytes. NaN on nonsense (an unparseable budget then never fires).
export function parseSize(s) {
  if (typeof s === 'number') return s;
  const m = String(s).trim().match(/^([\d.]+)\s*(B|KB|MB|GB)?$/i);
  return m ? Math.round(parseFloat(m[1]) * UNITS[(m[2] || 'B').toUpperCase()]) : NaN;
}

// A glob → an anchored regex WITH brace expansion ({png,jpg} → (?:png|jpg)). Kept local so the size
// dialect owns its own matching (the shared globMatch doesn't expand braces).
export function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '{') { const end = glob.indexOf('}', i); if (end > i) { re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end; continue; } }
    if (c === '*') { if (glob[i + 1] === '*') { re += (glob[i + 2] === '/') ? '(?:.*/)?' : '.*'; i += (glob[i + 2] === '/') ? 2 : 1; } else re += '[^/]*'; continue; }
    re += /[.+^${}()|[\]\\]/.test(c) ? '\\' + c : c;
  }
  return new RegExp('^' + re + '$');
}
export const globHit = (glob, path) => globToRe(glob).test(path);

// files [{ path, bytes }] over their FIRST-matching budget → violation strings. A path containing
// allowMarker is exempt (a deliberate, reviewable override).
export function overBudget({ files, budgets, allowMarker }) {
  const out = [];
  for (const { path, bytes } of files) {
    if (allowMarker && path.includes(allowMarker)) continue;
    for (const b of [].concat(budgets || [])) {
      if (!globHit(b.glob, path)) continue;                   // first matching budget wins
      const max = parseSize(b.max);
      if (Number.isFinite(max) && bytes > max) out.push(`${path} is ${(bytes / 1024).toFixed(0)}KB > ${b.max}${b.hint ? ` — ${b.hint}` : ''}`);
      break;
    }
  }
  return out;
}
