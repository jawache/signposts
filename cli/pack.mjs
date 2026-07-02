// cli/pack.mjs — the core pack manifest + the deterministic file helpers the CLI uses.
//
// The "core pack" is the set of files a fresh repo needs for the engine + gate to
// run: the engine, the core scripts, the ast-grep patterns, the hooks, the lefthook
// orchestration, and the /signposts skill. Merge targets (package.json, settings.json,
// signposts.yaml, justfile) are handled separately — they're woven, never clobbered.
//
// Everything here is pure I/O + data: no judgement (that's the /signposts skill).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';

export const PACK_NAME = '@signposts/core';

// Vendored, pack-owned files (copied verbatim, overwritten on refresh if unedited).
// Directories are expanded recursively at runtime, so a new core script is picked up
// automatically — no manifest edit needed.
const VENDOR_DIRS = [
  'rules/core',
  'rules/ast-grep',
  'rules/ast-grep-tests',
  '.claude/skills/signposts',
];
const VENDOR_FILES = [
  'rules/_engine.mjs',
  'rules/_util.mjs',
  'rules/_config.mjs',
  'rules/README.md',
  'rules/check-git-discard.mjs',
  'sgconfig.yml',
  'lefthook.yml',
  '.claude/agents/coach.md',   // the reflect detector — /signposts reflect spawns it
  '.claude/hooks/preemptive-block.mjs',
  '.claude/hooks/signposts.mjs',
  '.claude/hooks/signposts-core.mjs',
  '.claude/hooks/signposts-test.mjs',
  '.claude/hooks/lefthook-on-write.sh',
  '.claude/hooks/strip-claude-attribution.sh',
];

// Weave into package.json — the tools that arm + run the gate.
export const DEV_DEPENDENCIES = {
  '@ast-grep/cli': '^0.42.3',
  '@ast-grep/napi': '^0.42.3',
  lefthook: '^2.1.8',
  yaml: '^2.8.3',
};

// Run after copying — this ARMS the gate (copy alone enforces nothing).
export const ACTIVATE = ['npm install'];

// ── the vendored file list (repo-relative, present-only, sorted) ──────────────
export function listPackFiles(packRoot) {
  const out = new Set();
  for (const f of VENDOR_FILES) if (existsSync(join(packRoot, f))) out.add(f);
  for (const d of VENDOR_DIRS) walk(join(packRoot, d), packRoot, out);
  return [...out].sort();
}

function walk(absDir, root, out) {
  let entries;
  try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = join(absDir, e.name);
    if (e.isDirectory()) walk(abs, root, out);
    else if (e.isFile()) out.add(relative(root, abs));
  }
}

// ── small deterministic helpers ───────────────────────────────────────────────
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export const exists = (p) => existsSync(p);
export function readText(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
export function readBytes(p) { try { return readFileSync(p); } catch { return null; } }

export function ensureDir(p) { mkdirSync(p, { recursive: true }); }

export function writeText(p, s) { ensureDir(dirname(p)); writeFileSync(p, s); }
export function writeBytes(p, b) { ensureDir(dirname(p)); writeFileSync(p, b); }

// Copy a file, preserving its mode (so a .sh stays executable). Returns 'created' |
// 'updated' | 'unchanged' so callers can report + stay idempotent.
export function copyFile(src, dst) {
  const bytes = readFileSync(src);
  const before = existsSync(dst) ? readFileSync(dst) : null;
  if (before && before.equals(bytes)) return 'unchanged';
  ensureDir(dirname(dst));
  writeFileSync(dst, bytes, { mode: statSync(src).mode });
  return before ? 'updated' : 'created';
}
