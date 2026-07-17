// src/core/pure/scope.mjs — PURE decision: did a touched path fall within a rule's SCOPE?
// This is the "matched" metric behind the reflect report — the human-facing number that
// answers "did this rule engage with my work?", as opposed to `evaluated` (how many times
// the check merely ran, which for an unscoped deny-rule is once per file write).
//
// A rule's scope is, in order of precedence:
//   1. its explicit `on:` globs, when present;
//   2. else the resolved core script's own scope globs (protected-path returns its `deny`);
//   3. else null → the rule watches everything (every touched file matches).
// An empty glob list is treated as "watches everything" (nothing to exclude), never "nothing".

import { matchAny } from '../../util.mjs';

export function inScope(path, on, scopeGlobs) {
  const globs = on != null ? [].concat(on) : scopeGlobs != null ? [].concat(scopeGlobs) : null;
  if (globs == null || globs.length === 0) return true;   // no scope declared → watches everything
  return matchAny(path, globs);
}
