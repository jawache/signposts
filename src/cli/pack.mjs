// cli/pack.mjs — what the scaffold puts in a consumer repo, and the file helpers.
//
// The DEPENDENCY model: the engine, core scripts, and hooks live in the installed
// `signposts` package (node_modules/signposts) — the scaffold does NOT copy them in.
// It writes only CONFIG + WIRING, and copies the two files Claude Code can only
// discover from the project's own .claude/: the /signposts SKILL and the coach agent.
// Everything those reference (facts, diff, the engine) is invoked from the package.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const PACK_NAME = '@signposts/core';

// The ONLY files copied into the project — the discoverable surface (Claude Code reads
// skills/agents from .claude/, never from node_modules). Both call into the package.
export const SKILL_SURFACE = [
  '.claude/skills/signposts/SKILL.md',
  '.claude/agents/coach.md',
];

// Woven into package.json. `signposts` brings the engine + its deps (yaml, ast-grep). The commit
// gate needs no dependency — it's a committed .githooks/pre-commit + `git config core.hooksPath`.
export const DEV_DEPENDENCIES = {
  signposts: '^0.1.0',
};

// Run after writing — installs the dep. The gate is armed separately (git config core.hooksPath
// .githooks), which the scaffold does directly since it needs no package.
export const ACTIVATE = ['npm install'];

// ── small deterministic helpers ───────────────────────────────────────────────
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export const exists = (p) => existsSync(p);
export function readText(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
export function ensureDir(p) { mkdirSync(p, { recursive: true }); }
export function writeText(p, s) { ensureDir(dirname(p)); writeFileSync(p, s); }

// Copy a file, preserving mode. Returns 'created' | 'updated' | 'unchanged'.
export function copyFile(src, dst) {
  const bytes = readFileSync(src);
  const before = existsSync(dst) ? readFileSync(dst) : null;
  if (before && before.equals(bytes)) return 'unchanged';
  ensureDir(dirname(dst));
  writeFileSync(dst, bytes, { mode: statSync(src).mode });
  return before ? 'updated' : 'created';
}
