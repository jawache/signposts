// test/e2e/harness.mjs — the as-installed e2e harness (Phase B).
//
// The whole class of packaging bug (the yaml devDep bug, missing ship files, wrong hook
// paths) is INVISIBLE to in-repo unit tests, because those run where this repo's
// node_modules resolves everything. This harness runs in the AS-INSTALLED environment:
//
//   npm pack (honours package.json `files:`)  →  a real tarball
//   npm install <tarball> into a temp project →  node_modules/signposts, this repo invisible
//   drive the real CLI / engine from there    →  exactly what a consumer runs
//
// Pack + base-install are memoised per process; each test clones the base into a fresh,
// isolated working dir (cp, no re-install) so file-writing / git journeys don't collide.
//
// No framework: node:test only. No network beyond npm's cache (--prefer-offline).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── pack the repo once ────────────────────────────────────────────────────────
// `npm pack` works even under "private": true (publish is blocked; pack is not).
export function tarball() {
  if (process.env.SIGNPOSTS_TARBALL && existsSync(process.env.SIGNPOSTS_TARBALL)) return process.env.SIGNPOSTS_TARBALL;
  const dest = mkdtempSync(join(tmpdir(), 'sg-pack-'));
  const r = spawnSync('npm', ['pack', '--silent', '--pack-destination', dest], { cwd: REPO, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`npm pack failed:\n${r.stderr}`);
  const name = r.stdout.trim().split('\n').pop().trim();
  const tgz = join(dest, name);
  process.env.SIGNPOSTS_TARBALL = tgz;
  return tgz;
}

// ── install the tarball once into a base project we clone per test ────────────
// lefthook rides along so the commit-gate journey can arm a real git hook.
let _base = null;
export function baseProject() {
  if (_base && existsSync(_base)) return _base;
  const dir = mkdtempSync(join(tmpdir(), 'sg-base-'));
  writeFileSync(join(dir, 'package.json'),
    JSON.stringify({ name: 'consumer', version: '1.0.0', private: true, type: 'module' }, null, 2) + '\n');
  const r = spawnSync('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', tarball(), 'lefthook@^2.1.8'],
    { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`base npm install failed:\n${r.stderr}`);
  _base = dir;
  return dir;
}

// A fresh, isolated project with signposts installed (a copy of the base — no re-install).
export function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sg-e2e-'));
  cpSync(baseProject(), dir, { recursive: true });
  return dir;
}

const CLI = ['node_modules', 'signposts', 'src', 'cli', 'signposts.mjs'];
const ENGINE = ['node_modules', 'signposts', 'src', 'engine.mjs'];

// Pin the engine's root to THIS project — never let the outer Claude session's
// CLAUDE_PROJECT_DIR leak in and point the engine at the wrong tree.
function projEnv(dir, extra) { return { ...process.env, CLAUDE_PROJECT_DIR: dir, ...extra }; }

export function runCli(dir, args, opts = {}) {
  return spawnSync('node', [join(dir, ...CLI), ...args], { cwd: dir, encoding: 'utf8', env: projEnv(dir, opts.env), ...opts });
}
export function runEngine(dir, args, opts = {}) {
  return spawnSync('node', [join(dir, ...ENGINE), ...args], { cwd: dir, encoding: 'utf8', env: projEnv(dir, opts.env), ...opts });
}
export function runGit(dir, args, opts = {}) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: projEnv(dir, opts.env), ...opts });
}

// ── ship-completeness: does every bare import the package makes resolve here? ──
// This is the exact guard for the yaml bug — a runtime import that isn't installed.
function collectSpecs(src, out) {
  const re = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) { const s = m[1] || m[2] || m[3]; if (s) out.add(s); }
}
export function importedSpecs(pkgSrcDir) {
  const out = new Set();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.mjs$/.test(e.name)) collectSpecs(readFileSync(p, 'utf8'), out);
    }
  };
  walk(pkgSrcDir);
  // keep only external, non-builtin specifiers — relative imports resolve trivially, node: always resolves.
  return [...out].filter((s) => !/^[./]/.test(s) && !s.startsWith('node:'));
}
export function unresolvedSpecs(dir) {
  const specs = importedSpecs(join(dir, 'node_modules', 'signposts', 'src'));
  const bad = [];
  for (const s of specs) {
    const r = spawnSync('node', ['--input-type=module', '-e', `import.meta.resolve(${JSON.stringify(s)})`],
      { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) bad.push(s);
  }
  return bad;
}
// Simulate the yaml bug: remove an installed dependency (top-level and any nested copy).
export function removeDep(dir, name) {
  for (const base of [join(dir, 'node_modules'), join(dir, 'node_modules', 'signposts', 'node_modules')]) {
    try { rmSync(join(base, ...name.split('/')), { recursive: true, force: true }); } catch { /* absent */ }
  }
}

// ── tiny fs helpers ───────────────────────────────────────────────────────────
export function write(dir, rel, content) {
  const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); return p;
}
export function read(dir, rel) { try { return readFileSync(join(dir, rel), 'utf8'); } catch { return null; } }
export function has(dir, rel) { return existsSync(join(dir, rel)); }
