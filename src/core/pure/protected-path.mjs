// src/core/pure/protected-path.mjs — PURE decision: is a path one of the protected (deny) globs?
// No IO — the adapter (../protected-path.mjs) supplies the touched path and calls this.

import { matchAny } from '../../util.mjs';

export function protectedPathHits(path, deny) {
  return matchAny(path, deny) ? [`'${path}' is a protected path (do not edit directly)`] : [];
}
