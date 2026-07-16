// src/core/max-size.mjs — ADAPTER: committed files must respect a byte budget.
// The decisions are pure (./pure/max-size.mjs); this walks the tree, stats the files, and calls
// overBudget with what it collected. A file whose path contains allow_marker is exempted.
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
import { overBudget, parseSize, globHit } from './pure/max-size.mjs';
export { overBudget, parseSize, globHit };

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
