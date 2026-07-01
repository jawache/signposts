// cli/scaffold.mjs — `npx signposts` (bare) drops the core pack into a repo and arms it.
//
// Steps, all idempotent (a second run makes no changes):
//   1. copy the vendored pack files (engine, core scripts, ast-grep, hooks, skill)
//   2. merge package.json devDependencies (weave, never clobber)
//   3. merge .claude/settings.json hooks (add missing, keep yours)
//   4. write starter signposts.yaml + justfile — only if absent
//   5. write signposts.lock.json (pack version + a sha per vendored file → refresh)
//   6. activate: `npm install` (this is what writes .git/hooks/* — copy alone does nothing)

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  PACK_NAME, DEV_DEPENDENCIES, ACTIVATE, listPackFiles,
  copyFile, readText, writeText, readBytes, sha256, exists,
} from './pack.mjs';

export function scaffold({ packRoot, target, activate = true, log = console.log }) {
  const rel = (p) => join(target, p);
  const counts = { created: 0, updated: 0, unchanged: 0 };

  // 1. copy vendored files ------------------------------------------------------
  const files = listPackFiles(packRoot);
  for (const f of files) {
    const status = copyFile(join(packRoot, f), rel(f));
    counts[status]++;
  }
  log(`• pack files: ${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged (${files.length} total)`);

  // 2. merge package.json devDependencies --------------------------------------
  log(`• package.json: ${mergePackageJson(rel('package.json'), packRoot)}`);

  // 3. merge .claude/settings.json hooks ----------------------------------------
  log(`• .claude/settings.json: ${mergeSettings(rel('.claude/settings.json'), join(packRoot, '.claude/settings.json'))}`);

  // 4. starter files (only if absent) -------------------------------------------
  log(`• signposts.yaml: ${starter(rel('signposts.yaml'), join(packRoot, 'cli/templates/signposts.yaml'))}`);
  log(`• justfile: ${starter(rel('justfile'), join(packRoot, 'cli/templates/justfile'))}`);

  // 5. lock ---------------------------------------------------------------------
  log(`• signposts.lock.json: ${writeLock(rel('signposts.lock.json'), packRoot, files)}`);

  // 6. activate -----------------------------------------------------------------
  if (activate) {
    log(`• activate: ${ACTIVATE.join(' && ')}`);
    for (const cmd of ACTIVATE) {
      const r = spawnSync('bash', ['-lc', cmd], { cwd: target, stdio: 'inherit' });
      if (r.status !== 0) { log(`  ! activation command failed (exit ${r.status}); arm manually: ${cmd}`); break; }
    }
  } else {
    log(`• activate: skipped (run \`${ACTIVATE.join(' && ')}\` to arm the gate)`);
  }

  log(`\n✓ Signposts scaffolded. Restart your agent session so the pre-emptive hook loads,`);
  log(`  then ask it to create a file named signposts-is-bad.yaml to feel the block.`);
  return { files, counts };
}

// ── merge helpers (weave, never clobber; idempotent) ──────────────────────────

function mergePackageJson(dst, packRoot) {
  let pkg = {};
  const existing = readText(dst);
  if (existing) { try { pkg = JSON.parse(existing); } catch { /* leave {} → rewritten below */ } }
  else {
    // a fresh repo: seed a minimal package.json (scripts stays empty on purpose —
    // the justfile is the command source, enforced by core/json-invariant).
    pkg = { name: rootName(packRoot), version: '0.1.0', private: true, type: 'module',
            scripts: { '//': 'Commands live in the justfile — run `just`.' } };
  }
  pkg.devDependencies = pkg.devDependencies || {};
  let added = 0;
  for (const [name, ver] of Object.entries(DEV_DEPENDENCIES)) {
    if (!pkg.devDependencies[name]) { pkg.devDependencies[name] = ver; added++; }
  }
  const next = JSON.stringify(pkg, null, 2) + '\n';
  if (next === existing) return 'unchanged';
  writeText(dst, next);
  return existing ? `merged (${added} devDep${added === 1 ? '' : 's'} added)` : 'created';
}

function mergeSettings(dst, srcPath) {
  const incoming = safeJson(readText(srcPath))?.hooks;
  if (!incoming) return 'skipped (no source hooks)';
  const existing = readText(dst);
  const cfg = safeJson(existing) || {};
  cfg.hooks = cfg.hooks || {};
  let added = 0;
  for (const [event, groups] of Object.entries(incoming)) {
    cfg.hooks[event] = cfg.hooks[event] || [];
    for (const g of groups) {
      let tgt = cfg.hooks[event].find((x) => (x.matcher || '') === (g.matcher || ''));
      if (!tgt) { tgt = { ...(g.matcher ? { matcher: g.matcher } : {}), hooks: [] }; cfg.hooks[event].push(tgt); }
      tgt.hooks = tgt.hooks || [];
      for (const h of g.hooks || []) {
        if (!tgt.hooks.some((e) => e.command === h.command)) { tgt.hooks.push(h); added++; }
      }
    }
  }
  const next = JSON.stringify(cfg, null, 2) + '\n';
  if (next === existing) return 'unchanged';
  writeText(dst, next);
  return existing ? `merged (${added} hook${added === 1 ? '' : 's'} wired)` : 'created';
}

function starter(dst, srcTemplate) {
  if (exists(dst)) return 'kept (already present)';
  const tpl = readText(srcTemplate);
  if (tpl == null) return 'skipped (template missing)';
  writeText(dst, tpl);
  return 'created';
}

function writeLock(dst, packRoot, files) {
  const lock = { packs: { [PACK_NAME]: { version: rootVersion(packRoot), files: {} } } };
  for (const f of files) lock.packs[PACK_NAME].files[f] = sha256(readBytes(join(packRoot, f)));
  const next = JSON.stringify(lock, null, 2) + '\n';
  if (next === readText(dst)) return 'unchanged';
  writeText(dst, next);
  return 'written';
}

// ── tiny utilities ────────────────────────────────────────────────────────────
function safeJson(s) { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }
function rootVersion(packRoot) { return safeJson(readText(join(packRoot, 'package.json')))?.version || '0.0.0'; }
function rootName() { return 'my-project'; }
