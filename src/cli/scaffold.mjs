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
import { join, sep } from 'node:path';
import {
  DEV_DEPENDENCIES, ACTIVATE, SKILL_SURFACE, copyFile, readText, writeText, exists,
} from './pack.mjs';
import { ensureGitignore } from './install.mjs';

export function scaffold({ packRoot, target, activate = true, dryRun = false, log = console.log }) {
  const rel = (p) => join(target, p);
  if (dryRun) log(`DRY RUN — showing the footprint on ${target}; nothing will be written.\n`);

  // 1. copy the discoverable skill surface -------------------------------------
  let copied = 0;
  for (const f of SKILL_SURFACE) if (exists(join(packRoot, f))) { if (!dryRun && copyFile(join(packRoot, f), rel(f)) !== 'unchanged') copied++; }
  log(`• skill surface: ${dryRun ? `would write ${SKILL_SURFACE.length}` : `${copied} written`} (SKILL.md + coach.md — the only files copied; the engine stays in node_modules)`);

  // 2. merge package.json devDependencies --------------------------------------
  log(`• package.json: ${mergePackageJson(rel('package.json'), dryRun)}`);

  // 3. merge .claude/settings.json hooks (from the dep-wired template) ----------
  log(`• .claude/settings.json: ${mergeSettings(rel('.claude/settings.json'), join(packRoot, 'src/templates/settings.json'), dryRun)}`);

  // 4. starter files (only if absent) ------------------------------------------
  log(`• signposts.yml: ${starter(rel('signposts.yml'), join(packRoot, 'src/templates/signposts.yml'), dryRun)}`);
  log(`• sgconfig.yml: ${starter(rel('sgconfig.yml'), join(packRoot, 'src/templates/sgconfig.yml'), dryRun)}`);
  log(`• lefthook.yml: ${starter(rel('lefthook.yml'), join(packRoot, 'src/templates/lefthook.yml'), dryRun)}`);
  log(`• justfile: ${starter(rel('justfile'), join(packRoot, 'src/templates/justfile'), dryRun)}`);

  // 5. seed rules/ with the quick-start tour (only files that are absent) -------
  log(`• rules/: ${seedRules(join(packRoot, 'src/templates/rules-example'), join(target, 'rules'), dryRun)}`);

  // 5b. ignore the engine's local telemetry (.signposts/ — log, report cards, base snapshots)
  if (dryRun) log(`• .gitignore: would ensure .signposts/ is ignored`);
  else log(`• .gitignore: ${ensureGitignore(target) ? 'added .signposts/' : '.signposts/ already ignored'}`);

  // 6. activate -----------------------------------------------------------------
  if (dryRun) log(`• activate: would ${activate ? 'install signposts + arm the gate' : 'be skipped (--no-activate)'}`);
  else if (activate) runActivate(target, packRoot, log);
  else log(`• activate: skipped (run \`${ACTIVATE.join(' && ')}\` to install signposts + arm the gate)`);

  if (dryRun) { log(`\nDry run complete — re-run without --dry-run to apply.`); return; }
  log(`\n✓ Signposts wired in (as a dev dependency). Restart your agent session so the`);
  log(`  pre-emptive hook loads, then walk the quick-start tour in rules/README.md.`);
  log(`  The pack ships its own rules — see or adopt them with:  npx signposts diff node_modules/signposts`);
}

function runActivate(target, packRoot, log) {
  // Dev mode = the CLI is running from source (not from an installed node_modules copy).
  // Then signposts isn't published, so link the local build BY PATH — no registry, no
  // dependence on a global `npm link` (which nvm/login-shell differences can hide).
  if (!packRoot.includes(`${sep}node_modules${sep}`)) return devLinkActivate(target, packRoot, log);
  log(`• activate: npm install`);
  if (sh('npm install', target) !== 0) log(`  ! npm install failed — arm manually with \`npm install\`.`);
}

function devLinkActivate(target, packRoot, log) {
  log(`• activate: dev mode — linking your local build (signposts isn't published yet)`);
  if (sh(`npm link "${packRoot}"`, target) !== 0) {
    log(`  ! link failed — run this in the project by hand:  npm link "${packRoot}"`);
    return;
  }
  log(`  ✓ linked → node_modules/signposts. The PRE-EMPTIVE block is live after you restart the session.`);
  log(`  (The commit gate needs lefthook, which npm can't install while signposts is unpublished —`);
  log(`   it arms cleanly once signposts is published; \`npm install\` will pull lefthook then.)`);
}

// ── merge helpers (weave, never clobber; idempotent) ──────────────────────────
function mergePackageJson(dst, dryRun) {
  const existing = readText(dst);
  let pkg = existing ? safeJson(existing) || {} : { name: 'my-project', version: '0.1.0', private: true, type: 'module',
    scripts: { '//': 'Commands live in the justfile — run `just`.' } };
  pkg.devDependencies = pkg.devDependencies || {};
  let added = 0;
  // Only add a dep the project doesn't already declare — in EITHER dependencies or devDependencies.
  // (A consumer may already carry `signposts` in dependencies; adding it to devDependencies too
  // would double-list it.)
  const alreadyHas = (name) => (pkg.dependencies && pkg.dependencies[name]) || pkg.devDependencies[name];
  for (const [name, ver] of Object.entries(DEV_DEPENDENCIES)) if (!alreadyHas(name)) { pkg.devDependencies[name] = ver; added++; }
  const next = JSON.stringify(pkg, null, 2) + '\n';
  if (next === existing) return 'unchanged';
  const verb = existing ? `merge (${added} devDep${added === 1 ? '' : 's'})` : 'create';
  if (dryRun) return `would ${verb}`;
  writeText(dst, next);
  return existing ? `merged (${added} devDep${added === 1 ? '' : 's'} added)` : 'created';
}

function mergeSettings(dst, templatePath, dryRun) {
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
  const verb = existing ? `merge (${added} hook${added === 1 ? '' : 's'})` : 'create';
  if (dryRun) return `would ${verb}`;
  writeText(dst, next);
  return existing ? `merged (${added} hook${added === 1 ? '' : 's'} wired)` : 'created';
}

function starter(dst, srcTemplate, dryRun) {
  if (exists(dst)) return 'kept (already present)';
  const tpl = readText(srcTemplate);
  if (tpl == null) return 'skipped (template missing)';
  if (dryRun) return 'would create';
  writeText(dst, tpl);
  return 'created';
}

// Seed the consumer's rules/ with a worked example of each authoring path (an ast-grep
// pattern + a script + a README) so it's not an empty folder — copied only if absent.
function seedRules(srcDir, dstDir, dryRun) {
  if (!exists(srcDir)) return 'skipped (no examples)';
  let seeded = 0, kept = 0;
  for (const r of walk(srcDir)) {
    const dst = join(dstDir, r);
    if (exists(dst)) { kept++; continue; }
    if (!dryRun) copyFile(join(srcDir, r), dst);
    seeded++;
  }
  if (dryRun) return seeded ? `would seed ${seeded} tour file(s) into rules/` : 'kept (tour already present)';
  return seeded ? `${seeded} tour file(s) seeded into rules/` : (kept ? 'kept (tour already present)' : 'skipped');
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
