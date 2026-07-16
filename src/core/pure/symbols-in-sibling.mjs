// src/core/pure/symbols-in-sibling.mjs — PURE decision: of some exported names, which are never
// referenced in the sibling test's text? No IO. (Extracting the names needs a parser — that stays
// in the adapter, ../symbols-in-sibling.mjs, which imports @ast-grep/napi and reads the sibling.)

import { escapeRe } from '../../util.mjs';

export function unreferenced(names, siblingText) {
  return names.filter((n) => !new RegExp(`\\b${escapeRe(n)}\\b`).test(siblingText));
}
