// src/core/pure/change-together.mjs — PURE decision: which "must move together" groups were
// triggered without their companion? No IO — the adapter (../change-together.mjs) reads the
// staged set (git) and calls this.

import { matchAny } from '../../util.mjs';

// changed: repo-relative paths. groups: [{ if:[globs], then-any:[globs] }]. A group fires when an
// `if` glob changed but no `then-any` glob did → a violation string.
export function changeTogether({ changed, groups }) {
  const out = [];
  for (const g of [].concat(groups || [])) {
    const ifGlobs = [].concat(g.if || []);
    const thenGlobs = [].concat(g['then-any'] || g.thenAny || []);
    const triggered = changed.some((f) => matchAny(f, ifGlobs));
    if (!triggered) continue;
    const satisfied = changed.some((f) => matchAny(f, thenGlobs));
    if (!satisfied) out.push(`${ifGlobs.join(', ')} changed but none of [${thenGlobs.join(', ')}] did in the same commit`);
  }
  return out;
}
