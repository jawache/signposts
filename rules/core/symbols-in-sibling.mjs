// rules/core/symbols-in-sibling.mjs — every exported symbol is referenced in its
// sibling test. Correlates two files: parses the edited file for exports (a real
// parser, via @ast-grep/napi), then checks each name appears in the sibling.
//
// Config:  sibling: "{dir}/{name}.test.ts"
// Contract: kind 'content' → ctx = { path, content, root, exists, readText }.

import { join } from 'node:path';
import { escapeRe, expandTemplate } from '../_util.mjs';

export async function exportedNames(content) {
  const { parse, Lang } = await import('@ast-grep/napi');
  const root = parse(Lang.Tsx, content).root();
  const out = new Set();
  for (const p of ['export function $N($$$) { $$$ }', 'export class $N { $$$ }', 'export const $N = $V']) {
    for (const m of root.findAll(p)) { const n = m.getMatch('N'); if (n) out.add(n.text()); }
  }
  return [...out];
}
export function unreferenced(names, siblingText) {
  return names.filter((n) => !new RegExp(`\\b${escapeRe(n)}\\b`).test(siblingText));
}

export default {
  kind: 'content',
  async evaluate(rule, ctx) {
    const sibling = expandTemplate(rule.sibling, ctx.path);
    const text = ctx.readText(join(ctx.root, sibling));
    if (text == null) return [`sibling test not found: ${sibling}`];
    const names = await exportedNames(ctx.content);
    return unreferenced(names, text).map((n) => `exported '${n}' is never referenced in ${sibling}`);
  },
  async test() {
    const names = await exportedNames('export function foo(){}\nexport const bar = () => 1;');
    const got = names.includes('foo') && names.includes('bar');
    const flagged = unreferenced(names, 'test(foo)');           // bar unreferenced
    return { name: 'core/symbols-in-sibling', pass: got && flagged.length === 1 && flagged[0] === 'bar' };
  },
};
