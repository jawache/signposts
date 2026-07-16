// src/core/symbols-in-sibling.mjs — ADAPTER: every exported symbol is referenced in its sibling
// test. Parsing the exports needs a real parser (@ast-grep/napi) and reading the sibling is IO, so
// both live here; the pure decision (which names are unreferenced) is ./pure/symbols-in-sibling.mjs.
//
// Config:  sibling: "{dir}/{name}.test.ts"
// Contract: kind 'content' → ctx = { path, content, root, exists, readText }.

import { join } from 'node:path';
import { expandTemplate } from '../util.mjs';
import { unreferenced } from './pure/symbols-in-sibling.mjs';
export { unreferenced };

export async function exportedNames(content) {
  const { parse, Lang } = await import('@ast-grep/napi');
  const root = parse(Lang.Tsx, content).root();
  const out = new Set();
  for (const p of ['export function $N($$$) { $$$ }', 'export class $N { $$$ }', 'export const $N = $V']) {
    for (const m of root.findAll(p)) { const n = m.getMatch('N'); if (n) out.add(n.text()); }
  }
  return [...out];
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
