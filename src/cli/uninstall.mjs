// cli/uninstall.mjs — `npx signposts uninstall`: remove Signposts from a repo.
//
// Reverses a scaffold — the old vendored model AND the new dependency model:
//   • unarms lefthook (removes the .git/hooks/* it wrote)
//   • deletes the vendored files the lock recorded (old model) — precise: the lock lists
//     exactly what was copied in, so your own files are never touched
//   • deletes the known surface (skill, coach, config, wiring) — covers the dep model
//   • unwires the Signposts hooks from .claude/settings.json (surgical)
//   • drops the devDependencies it added
//
// CONSERVATIVE + TRANSPARENT: it touches only what's unambiguously Signposts', logs
// every action, and REPORTS what it can't safely auto-undo (a merged justfile, your own
// rules/<namespace>/, node_modules). Use --dry-run to preview.

import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { PACK_NAME, readText } from './pack.mjs';
import { editYaml, assertSafeNamespace } from './install.mjs';

// A hook command belongs to Signposts if it names one of our hook files or the package.
const OURS = /(?:\.claude\/hooks\/(?:preemptive-block|command-guard|signposts|signposts-core|signposts-test|lefthook-on-write|strip-claude-attribution)|rules\/check-git-discard|node_modules\/signposts)/;
// The known copied surface (new dep model has no lock; old model also lands these).
const SURFACE = [
  '.claude/skills/signposts', '.claude/agents/coach.md', 'sgconfig.yml',
  '.claude/hooks/preemptive-block.mjs', '.claude/hooks/command-guard.mjs',
  '.claude/hooks/signposts.mjs', '.claude/hooks/signposts-core.mjs',
  '.claude/hooks/signposts-test.mjs', '.claude/hooks/lefthook-on-write.sh',
  '.claude/hooks/strip-claude-attribution.sh',
];
const OUR_DEVDEPS = ['signposts', 'lefthook', '@ast-grep/cli', '@ast-grep/napi'];

export function uninstall({ target = process.cwd(), dryRun = false, pack = null, log = console.log } = {}) {
  if (pack) return uninstallPack({ target, namespace: pack, dryRun, log }); // remove one pack namespace, not everything
  const rel = (p) => join(target, p);
  const tag = dryRun ? '[dry] ' : '';
  const seen = new Set();
  const rm = (p, label) => {
    if (seen.has(p) || !existsSync(p)) return false;
    seen.add(p);
    log(`${tag}removed ${label}`);
    if (!dryRun) { try { rmSync(p, { recursive: true, force: true }); pruneEmpty(dirname(p), target); } catch (e) { log(`  ! ${e.message}`); } }
    return true;
  };

  // 1. unarm lefthook (best effort) --------------------------------------------
  if (existsSync(rel('.git'))) {
    log(`${tag}unarm lefthook (npx lefthook uninstall)`);
    if (!dryRun) spawnSync('bash', ['-lc', 'npx --no-install lefthook uninstall'], { cwd: target, stdio: 'ignore' });
  }

  // 2. vendored files from the lock (old model — precise, warns on local edits) -
  const lock = safeJson(readText(rel('signposts.lock.json')));
  const vendored = lock?.packs?.[PACK_NAME]?.files || {};
  let vendoredCount = 0;
  for (const f of Object.keys(vendored)) {
    if (!existsSync(rel(f))) continue;
    vendoredCount++;
    rm(rel(f), f);
  }
  if (vendoredCount) log(`  (${vendoredCount} vendored file(s) from signposts.lock.json)`);

  // 3. the known surface (covers the dep model / anything not in a lock) --------
  for (const f of SURFACE) rm(rel(f), f);
  // lefthook.yml only if it's the Signposts one
  if (/node_modules\/signposts\/rules\/_engine|name: (signposts|engine)/.test(readText(rel('lefthook.yml')) || '')) rm(rel('lefthook.yml'), 'lefthook.yml');

  // 4. config -------------------------------------------------------------------
  rm(rel('signposts.yaml'), 'signposts.yaml');
  rm(rel('signposts.lock.json'), 'signposts.lock.json');

  // 5. unwire settings.json hooks ----------------------------------------------
  log(`${tag}.claude/settings.json: ${unwireSettings(rel('.claude/settings.json'), dryRun)}`);

  // 6. drop our devDependencies -------------------------------------------------
  log(`${tag}package.json: ${dropDevDeps(rel('package.json'), dryRun)}`);

  // 7. what we deliberately did NOT touch --------------------------------------
  log('');
  log('Left in place (yours to review):');
  if (existsSync(rel('justfile'))) log('  • justfile — Signposts merged recipes in; remove test-rules/gate/refresh by hand if unused.');
  if (existsSync(rel('rules'))) log('  • rules/ — any rules/<namespace>/ you authored are yours; delete manually if desired.');
  log('  • node_modules — run `npm install` to prune, or `npm uninstall signposts lefthook`.');
  log(dryRun ? '\n(dry run — nothing was changed)' : '\n✓ Signposts removed.');
}

// Remove ONE installed pack namespace (the reverse of `install <src> <ns>`): its
// signs:/rules: groups, rules/<ns>/, the settings.json entries the owning pack(s)
// recorded (kept if a surviving pack or a hand-written entry still needs them), and its
// packs: entry. Comment-preserving; hand-written config is never touched.
export function uninstallPack({ target = process.cwd(), namespace, dryRun = false, log = console.log }) {
  assertSafeNamespace(namespace);                        // path-traversal guard before any rmSync
  const yamlPath = join(target, 'signposts.yaml');
  if (!existsSync(yamlPath)) { log('no signposts.yaml — nothing to uninstall'); return; }
  const tag = dryRun ? '[dry] ' : '';

  // 1. work out which settings.json entries this namespace's pack(s) own AND whether any
  //    surviving pack entry still needs them (only purge the ones nothing else keeps).
  //    CAVEAT: a pack's permission ledger is per-pack-source, not per-namespace, so removing
  //    ONE namespace of a multi-namespace pack purges no permissions (willEmpty is false) —
  //    they're released only when the pack's last namespace goes. Acceptable: the common case
  //    is one namespace per source; the multi-ns case just keeps permissions until full removal.
  const doc0 = (() => { try { return parseYaml(readFileSync(yamlPath, 'utf8')) || {}; } catch { return {}; } })();
  const packs = Array.isArray(doc0.packs) ? doc0.packs : [];
  const owned = { deny: new Set(), allow: new Set() };
  const survives = { deny: new Set(), allow: new Set() };
  for (const p of packs) {
    if (!p || typeof p !== 'object') continue;
    const ns = p.namespaces || [];
    const willEmpty = ns.includes(namespace) && ns.filter((n) => n !== namespace).length === 0;
    for (const kind of ['deny', 'allow']) for (const e of (p.settings?.[kind] || [])) (willEmpty ? owned : survives)[kind].add(e);
  }
  const toRemove = {
    deny: [...owned.deny].filter((e) => !survives.deny.has(e)),
    allow: [...owned.allow].filter((e) => !survives.allow.has(e)),
  };

  // 2. yaml: drop the ns groups + prune packs entries (comment-preserving).
  if (!dryRun) editYaml(yamlPath, (doc) => {
    for (const section of ['signs', 'rules']) if (doc.getIn([section, namespace]) != null) doc.deleteIn([section, namespace]);
    const arr = (doc.toJS() || {}).packs || [];        // node.toJS() needs the doc; read via the Document
    const kept = [];
    for (const p of arr) {
      if (!p || typeof p !== 'object') { kept.push(p); continue; }
      const had = (p.namespaces || []).includes(namespace);
      const ns = (p.namespaces || []).filter((n) => n !== namespace);
      if (had && !ns.length) continue;                 // this pack existed only for <ns> → drop it
      kept.push(had ? { ...p, namespaces: ns } : p);
    }
    doc.setIn(['packs'], doc.createNode(kept));
  });
  log(`${tag}signposts.yaml: removed signs/rules for "${namespace}", pruned packs: entry`);

  // 3. rules/<ns>/
  const rulesDir = join(target, 'rules', namespace);
  if (existsSync(rulesDir)) { log(`${tag}removed rules/${namespace}/`); if (!dryRun) rmSync(rulesDir, { recursive: true, force: true }); }

  // 4. settings.json: remove only the pack-owned entries nothing else keeps.
  const setPath = join(target, '.claude', 'settings.json');
  if ((toRemove.deny.length || toRemove.allow.length) && existsSync(setPath)) {
    const cfg = safeJson(readText(setPath)) || {};
    let removed = 0;
    for (const kind of ['deny', 'allow']) {
      if (!Array.isArray(cfg.permissions?.[kind])) continue;
      const before = cfg.permissions[kind].length;
      cfg.permissions[kind] = cfg.permissions[kind].filter((e) => !toRemove[kind].includes(e));
      removed += before - cfg.permissions[kind].length;
    }
    if (!dryRun && removed) writeFileSync(setPath, JSON.stringify(cfg, null, 2) + '\n');
    log(`${tag}.claude/settings.json: removed ${removed} pack permission(s) (hand-written + shared kept)`);
  }
  log(dryRun ? '\n(dry run — nothing changed)' : `\n✓ removed pack namespace "${namespace}".`);
}

// ── helpers ───────────────────────────────────────────────────────────────────
function unwireSettings(path, dryRun) {
  const raw = readText(path);
  const cfg = safeJson(raw);
  if (!cfg?.hooks) return 'no hooks to unwire';
  let removed = 0;
  for (const [event, groups] of Object.entries(cfg.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) continue;
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((h) => !(h?.command && OURS.test(h.command)));
      removed += before - g.hooks.length;
    }
    cfg.hooks[event] = groups.filter((g) => Array.isArray(g.hooks) ? g.hooks.length : true);
    if (!cfg.hooks[event].length) delete cfg.hooks[event];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  if (!removed) return 'no Signposts hooks found';
  const next = JSON.stringify(cfg, null, 2) + '\n';
  if (!dryRun && next !== raw) writeFileSync(path, next);
  return `unwired ${removed} hook(s)`;
}

function dropDevDeps(path, dryRun) {
  const raw = readText(path);
  const pkg = safeJson(raw);
  if (!pkg?.devDependencies) return 'no devDependencies';
  const dropped = OUR_DEVDEPS.filter((d) => pkg.devDependencies[d]);
  for (const d of dropped) delete pkg.devDependencies[d];
  if (!dropped.length) return 'none of ours present';
  if (pkg.devDependencies.yaml) dropped.push('(kept `yaml` — commonly shared; remove by hand if unused)');
  const next = JSON.stringify(pkg, null, 2) + '\n';
  if (!dryRun && next !== raw) writeFileSync(path, next);
  return `dropped ${dropped.join(', ')}`;
}

function pruneEmpty(dir, stop) {
  try {
    while (dir && dir.startsWith(stop) && dir !== stop && readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: true, force: true });
      dir = dirname(dir);
    }
  } catch { /* ignore */ }
}
function safeJson(s) { if (!s) return null; try { return JSON.parse(s); } catch { return null; } }
