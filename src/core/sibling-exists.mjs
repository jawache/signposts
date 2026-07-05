// rules/core/sibling-exists.mjs — a file must have a required companion on disk.
//
// e.g. every src/domain/**/*.ts needs a sibling {dir}/{name}.test.ts. Path-shape
// only: it reads no content, just checks the sibling exists.
//
// Config:  sibling: "{dir}/{name}.test.ts"   (template over the touched path)
// Contract: kind 'path' → ctx = { path, root, exists, readText }.

import { join } from 'node:path';
import { expandTemplate } from '../util.mjs';

export default {
  kind: 'path',
  evaluate(rule, ctx) {
    const sibling = expandTemplate(rule.sibling, ctx.path);
    return ctx.exists(join(ctx.root, sibling)) ? [] : [`required sibling missing: ${sibling}`];
  },
  test() {
    const have = new Set(['/r/a/x.ts', '/r/a/x.test.ts']);
    const ctx = (path) => ({ path, root: '/r', exists: (p) => have.has(p) });
    const rule = { sibling: '{path}.test.ts' };
    const legal = this.evaluate(rule, ctx('a/x.ts')).length === 0;     // x.test.ts exists
    const illegal = this.evaluate(rule, ctx('a/y.ts')).length === 1;   // y.test.ts missing
    return { name: 'core/sibling-exists', pass: legal && illegal };
  },
};
