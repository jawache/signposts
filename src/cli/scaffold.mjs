// cli/scaffold.mjs — `npx signposts` (bare) sets a repo up on the DEPENDENCY model.
//
// It does NOT copy the engine/hooks/core-scripts in — those live in the installed
// `signposts` package. It writes only CONFIG + WIRING that points at the package, and
// copies the two files Claude Code can only discover from the project's own .claude/
// (the /signposts SKILL + the coach agent). Everything is idempotent.
//
//   1. copy the skill surface (SKILL.md + coach.md)
//   2. merge package.json devDependencies (signposts + lefthook)
//   3. write .claude/settings.json (hooks → node_modules/signposts), merge-not-clobber
//   4. write signposts.yaml + lefthook.yml + justfile — only if absent
//   5. activate: npm install (arms lefthook). Pre-publish: falls back to `npm link`.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEV_DEPENDENCIES, ACTIVATE, SKILL_SURFACE, copyFile, readText, writeText, exists,
} from './pack.mjs';

export function scaffold({ packRoot, target, activate = true, log = console.log }) {
  const rel = (p) => join(target, p);

  // 1. copy the discoverable skill surface -------------------------------------
  let copied = 0;
  for (const f of SKILL_SURFACE) if (exists(join(packRoot, f))) { if (copyFile(join(packRoot, f), rel(f)) !== 'unchanged') copied++; }
  log(`• skill surface: ${copied} written / ${SKILL_SURFACE.length} (SKILL.md + coach.md — the only files copied; the engine stays in node_modules)`);

  // 2. merge package.json devDependencies --------------------------------------
  log(`• package.json: ${mergePackageJson(rel('package.json'))}`);

  // 3. merge .claude/settings.json hooks (from the dep-wired template) ----------
  log(`• .claude/settings.json: ${mergeSettings(rel('.claude/settings.json'), join(packRoot, 'src/templates/settings.json'))}`);

  // 4. starter files (only if absent) ------------------------------------------
  log(`• signposts.yaml: ${starter(rel('signposts.yaml'), join(packRoot, 'src/templates/signposts.yaml'))}`);
  log(`• lefthook.yml: ${starter(rel('lefthook.yml'), join(packRoot, 'src/templates/lefthook.yml'))}`);
  log(`• justfile: ${starter(rel('justfile'), join(packRoot, 'src/templates/justfile'))}`);

  // 5. seed rules/ with a worked example of each authoring path (only if absent) -
  log(`• rules/: ${seedRules(join(packRoot, 'src/templates/rules-example'), join(target, 'rules'), log)}`);

  // 6. activate -----------------------------------------------------------------
  if (activate) runActivate(target, packRoot, log);
  else log(`• activate: skipped (run \`${ACTIVATE.join(' && ')}\` to install signposts + arm the gate)`);

  log(`\n✓ Signposts wired in (as a dev dependency). Restart your agent session so the`);
  log(`  pre-emptive hook loads, then ask it to create signposts-is-bad.yaml to feel the block.`);
}

function runActivate(target, packRoot, log) {
  const linked = isDevLinked();
  if (linked) {
    // Pre-publish: signposts isn't on the registry, so link the dev build instead.
    log(`• activate: dev-link mode (signposts is npm-linked, not yet published)`);
    sh('npm link signposts', target, log);
    log(`  linked signposts → your dev build. For the commit gate you also need lefthook:`);
    log(`  run \`npm install\` once signposts is published, or \`npm i -D lefthook\` to test now.`);
  } else {
    log(`• activate: ${ACTIVATE.join(' && ')}`);
    for (const cmd of ACTIVATE) if (sh(cmd, target, log) !== 0) { log(`  ! ${cmd} failed — arm manually.`); break; }
  }
}

// ── merge helpers (weave, never clobber; idempotent) ──────────────────────────
function mergePackageJson(dst) {
  const existing = readText(dst);
  let pkg = existing ? safeJson(existing) || {} : { name: 'my-project', version: '0.1.0', private: true, type: 'module',
    scripts: { '//': 'Commands live in the justfile — run `just`.' } };
  pkg.devDependencies = pkg.devDependencies || {};
  let added = 0;
  for (const [name, ver] of Object.entries(DEV_DEPENDENCIES)) if (!pkg.devDependencies[name]) { pkg.devDependencies[name] = ver; added++; }
  const next = JSON.stringify(pkg, null, 2) + '\n';
  if (next === existing) return 'unchanged';
  writeText(dst, next);
  return existing ? `merged (${added} devDep${added === 1 ? '' : 's'} added)` : 'created';
}

function mergeSettings(dst, templatePath) {
  const incoming = safeJson(readText(templatePath))?.hooks;
  if (!incoming) return 'skipped (no template)';
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
      for (const h of g.hooks || []) if (!tgt.hooks.some((e) => e.command === h.command)) { tgt.hooks.push(h); added++; }
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

// Seed the consumer's rules/ with a worked example of each authoring path (an ast-grep
// pattern + a script + a README) so it's not an empty folder — copied only if absent.
function seedRules(srcDir, dstDir) {
  if (!exists(srcDir)) return 'skipped (no examples)';
  let seeded = 0, kept = 0;
  for (const r of walk(srcDir)) {
    const dst = join(dstDir, r);
    if (exists(dst)) { kept++; continue; }
    copyFile(join(srcDir, r), dst); seeded++;
  }
  return seeded ? `${seeded} example(s) seeded into rules/` : (kept ? 'kept (examples already present)' : 'skipped');
}
function walk(dir, base = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), r));
    else out.push(r);
  }
  return out;
}

// ── utilities ─────────────────────────────────────────────────────────────────
function safeJson(s) { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }
function sh(cmd, cwd, log) { const r = spawnSync('bash', ['-lc', cmd], { cwd, stdio: 'inherit' }); return r.status ?? 1; }
function isDevLinked() {
  const r = spawnSync('bash', ['-lc', 'npm ls -g --depth=0 --link=true 2>/dev/null | grep -q "signposts@"'], { encoding: 'utf8' });
  return r.status === 0;
}
