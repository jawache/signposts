// src/core/max-size.mjs — committed files must respect a byte budget.
//
// A performance budget you don't enforce is a wish: an unoptimised hero image or a bloated font
// slips in and the page gets slower one commit at a time. This project-kind rule walks the tree,
// matches each file to the FIRST budget whose glob it fits, and blocks anything over the limit.
// A file whose path contains the `allow_marker` is exempted (a deliberate, reviewable override).
//
// Config:  on: ["public/**", "src/assets/**"]         # (optional) scope the walk
//          budgets:
//            - { glob: "**/*.{png,jpg,jpeg,gif}", max: 200KB, hint: "convert to webp/avif" }
//            - { glob: "**/*", max: 500KB }
//          allow_marker: ".budget-ok."
// Contract: kind 'project' → ctx = { root }. Fails safe: an unreadable file is skipped.

import { statSync } from 'node:fs';
import { relative } from 'node:path';
import { walkFiles } from './fs.mjs';

const UNITS = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };

// "200KB" | "1.5 MB" | 4096 → bytes. NaN on nonsense (an unparseable budget then never fires).
export function parseSize(s) {
  if (typeof s === 'number') return s;
  const m = String(s).trim().match(/^([\d.]+)\s*(B|KB|MB|GB)?$/i);
  return m ? Math.round(parseFloat(m[1]) * UNITS[(m[2] || 'B').toUpperCase()]) : NaN;
}

// A glob → an anchored regex WITH brace expansion ({png,jpg} → (?:png|jpg)), which the shared
// globMatch deliberately doesn't do. Kept local so the size dialect owns its own matching.
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '{') { const end = glob.indexOf('}', i); if (end > i) { re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end; continue; } }
    if (c === '*') { if (glob[i + 1] === '*') { re += (glob[i + 2] === '/') ? '(?:.*/)?' : '.*'; i += (glob[i + 2] === '/') ? 2 : 1; } else re += '[^/]*'; continue; }
    re += /[.+^${}()|[\]\\]/.test(c) ? '\\' + c : c;
  }
  return new RegExp('^' + re + '$');
}
const globHit = (glob, path) => globToRe(glob).test(path);

// Pure: files [{ path, bytes }] over their first-matching budget → violation strings.
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

export default {
  kind: 'project',
  evaluate(rule, ctx) {
    const scope = rule.on ? [].concat(rule.on) : null;
    const files = walkFiles(ctx.root, { skip: ['.git', 'node_modules'] })
      .map((abs) => ({ abs, path: relative(ctx.root, abs) }))
      .filter(({ path }) => !scope || scope.some((g) => globHit(g, path)))
      .map(({ abs, path }) => { try { return { path, bytes: statSync(abs).size }; } catch { return null; } })
      .filter(Boolean);
    return overBudget({ files, budgets: rule.budgets, allowMarker: rule.allow_marker });
  },
  test() {
    const budgets = [{ glob: '**/*.{png,jpg}', max: '200KB', hint: 'compress it' }, { glob: '**/*', max: '500KB' }];
    const ev = (files) => overBudget({ files, budgets, allowMarker: '.budget-ok.' });
    const under = ev([{ path: 'public/a.png', bytes: 100 * 1024 }]).length === 0;
    const over = ev([{ path: 'public/a.png', bytes: 300 * 1024 }]).length === 1;      // 300KB > 200KB image budget
    const fallback = ev([{ path: 'public/b.bin', bytes: 600 * 1024 }]).length === 1;  // 600KB > 500KB catch-all
    const marked = ev([{ path: 'public/big.budget-ok.png', bytes: 900 * 1024 }]).length === 0; // opted out
    const sizes = parseSize('200KB') === 204800 && parseSize('1.5 MB') === 1572864 && parseSize(4096) === 4096;
    const braces = globHit('**/*.{png,jpg}', 'a/b/c.jpg') && !globHit('**/*.{png,jpg}', 'a/b/c.gif');
    return { name: 'core/max-size', pass: under && over && fallback && marked && sizes && braces };
  },
};
