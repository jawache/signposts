// src/core/pure/tool-gate.mjs — PURE decisions for the tool-gate: should it skip (its area didn't
// change), and which output lines to surface FIRST on failure. No IO — the adapter (../tool-gate.mjs)
// spawns the tool and calls these.

import { matchAny } from '../../util.mjs';

// Skip the gate? True only when `changed` globs are given AND none of the checked files match — so a
// file-scoped gate (a type-checker for site/**) stays quiet on commits that don't touch its area.
// No globs, or no files to judge → run (fail-safe: never silently skip a gate we can't scope).
export function skipForChanged(files, changed) {
  const globs = [].concat(changed || []);
  if (!globs.length) return false;
  if (!Array.isArray(files) || !files.length) return false;
  return !files.some((f) => matchAny(f, globs));
}

// The lines worth showing FIRST on failure — the actual errors, not a tool's verbose success chatter.
// Prefer lines that look like a failure; fall back to the tail. Capped so a blocked commit stays terse
// (the whole point: quiet on pass, and on failure the error is up top, not buried).
export function failureExcerpt(output, cap = 8) {
  const lines = String(output).trim().split('\n').filter(Boolean);
  const hot = lines.filter((l) => /\b(fail|failed|error|not ok|assert|expected|cannot|undefined)\b/i.test(l) || /[✖✗✘]/.test(l));
  return (hot.length ? hot : lines.slice(-6)).slice(0, cap).join('\n');
}
