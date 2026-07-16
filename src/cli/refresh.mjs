// cli/refresh.mjs — `npx signposts refresh` pulls updates for installed packs.
//
// The CORE updates via npm (`npm update signposts`); refresh then re-copies the skill surface
// (SKILL.md + coach.md) from that package into .claude/, since those are copied in at scaffold and
// npm can't move them. What refresh otherwise handles is the installed
// PACKS (the sources in your packs: list). For each shared namespace it does a THREE-WAY
// merge against the base snapshot install took (.signposts/base/<ns>/):
//   • only upstream changed  → take upstream
//   • only you changed       → keep yours
//   • both changed the same  → no-op
//   • both diverged          → CONFLICT: keep yours untouched, drop a <file>.upstream
//                              sidecar (scripts) / report the id (entries). Never clobber.
// Conflict markers are NEVER written into a live rule file (that would silently stop it
// enforcing). Missing base (installed before this, or a fresh clone — .signposts is
// gitignored) → keep-local with a notice; re-install to arm merging.

import { join, dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { PACK_NAME, readText, SKILL_SURFACE, copyFile, exists } from './pack.mjs';
import { resolveSource } from './source.mjs';
import { loadPacks, diffPacks, canon } from '../skill/pack-diff.mjs';
import { installPack, applyNamespace, editYaml, snapshotBase, walk, copyInto, assertSafeNamespace, blockNode, ensureBlockSection } from './install.mjs';
import { resolveConfigPath } from '../schema.mjs';

export function refresh({ target = process.cwd(), log = console.log }) {
  log(`[${PACK_NAME}] the core ships in the signposts package — run \`npm update signposts\` to update it.`);
  refreshSkillSurface(target, log);
  const results = refreshInstalledPacks(target, log);
  const added = results.reduce((a, r) => a + (r.added || 0), 0);
  const took = results.reduce((a, r) => a + (r.took || 0), 0);
  const conflicts = results.reduce((a, r) => a + ((r.conflicts || []).length), 0);
  log(`\nInstalled packs: ${results.length} merge(s), ${took} upstream update(s) taken, ${added} new entr(y/ies), ${conflicts} conflict(s) (kept local).`);
  return { packs: results };
}

// The skill surface (SKILL.md + coach.md) is COPIED into the project at scaffold — the agent loads
// it from .claude/, not node_modules — so `npm update signposts` refreshes the engine but leaves
// that copy behind (a stale skill: a missing mode, old wording). Re-copy it from the package that
// is actually running this command (resolved from here, so it's the version the project uses). It's
// vendor-owned; if you deliberately forked it, the overwrite shows up in your `git diff` to revert.
function refreshSkillSurface(target, log) {
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');   // <pkg>/src/cli → <pkg>
  let updated = 0;
  for (const f of SKILL_SURFACE) {
    const src = join(pkgRoot, f);
    if (!exists(src)) continue;
    const r = copyFile(src, join(target, f));                                     // 'created' | 'updated' | 'unchanged'
    if (r !== 'unchanged') { updated++; log(`  skill surface: ${r} ${f}`); }
  }
  if (!updated) log('  skill surface: up to date');
  return updated;
}

function refreshInstalledPacks(target, log) {
  const doc = (() => { try { return parseYaml(readText(resolveConfigPath(target))) || {}; } catch { return {}; } })();
  // packs: entries are plain strings (legacy) OR objects { source, namespaces, … } (Phase 4).
  const specs = (doc.packs || [])
    .map((p) => (typeof p === 'string' ? p : p?.source))
    .filter((s) => s && s !== PACK_NAME && !/@signposts\/core/.test(s));
  if (!specs.length) { log('  (no installed packs to refresh)'); return []; }
  const out = [];
  for (const spec of specs) {
    let resolved;
    try { resolved = resolveSource(spec); } catch (e) { log(`! ${spec}: ${e.message}`); out.push({ spec, error: e.message }); continue; }
    const src = loadPacks(resolved.path);
    const tgt = loadPacks(target);
    const shared = new Set([...Object.keys(src.signs), ...Object.keys(src.rules)].filter((ns) => (tgt.signs[ns] || tgt.rules[ns])));
    log(`[${spec}] ${[...shared].join(', ') || '(no shared ns)'}`);
    for (const ns of shared) out.push({ spec, ...mergeNamespace({ srcPath: resolved.path, src, namespace: ns, target, log }) });
  }
  return out;
}

// Three-way merge one namespace: yaml entries + scripts, against the install-time base.
function mergeNamespace({ srcPath, src, namespace, target, log }) {
  assertSafeNamespace(namespace);                        // path-traversal guard before any file op
  const baseDir = join(target, '.signposts', 'base', namespace);
  if (!existsSync(baseDir)) {                             // no base → keep-local fallback (+ pull genuinely-new)
    log(`  [${namespace}] no base snapshot (installed before three-way merge, or fresh clone) — keeping local versions; re-install the pack to arm merging.`);
    const report = diffPacks(src, loadPacks(target), namespace);
    const r = applyNamespace({ srcPath, srcPacks: src, namespace, target, report });
    return { namespace, fallback: true, added: r.added, took: 0, kept: 0, conflicts: r.collisions.map((c) => `${c} (kept local — no base)`) };
  }

  const baseSlice = (() => { try { return parseYaml(readFileSync(join(baseDir, '_entries.yaml'), 'utf8')) || {}; } catch { return {}; } })();
  const conflicts = [];
  let took = 0, kept = 0, added = 0;

  // 1. entries (signs + rules) — per-id three-way, comment-preserving write only if changed.
  editYaml(resolveConfigPath(target), (doc) => {
    const js = doc.toJS() || {};
    for (const section of ['signs', 'rules']) {
      const local = js[section]?.[namespace] || [];
      const m = mergeEntries({ base: baseSlice[section] || [], local, upstream: src[section][namespace] || [] });
      took += m.took; kept += m.kept; added += m.added;
      conflicts.push(...m.conflicts.map((id) => `${section}/${id}`));
      if (canon(m.merged) !== canon(local) && m.merged.length) {
        ensureBlockSection(doc, section, js);
        doc.setIn([section, namespace], blockNode(doc.createNode(m.merged)));
      }
    }
  });

  // 2. scripts — three-way via git merge-file (on temp copies; never markers in a live file).
  const upstreamDir = join(srcPath, 'rules', namespace);
  if (existsSync(upstreamDir)) for (const rel of walk(upstreamDir, srcPath)) {   // rel = rules/<ns>/x
    const localFile = join(target, rel), upstreamFile = join(srcPath, rel), baseFile = join(baseDir, rel);
    if (!existsSync(localFile)) { copyInto(upstreamFile, localFile); added++; continue; } // brand-new script
    const res = threeWayFile({ baseFile, localFile, upstreamFile });
    if (res === 'clean') took++;
    else if (res === 'conflict') conflicts.push(`${rel} → ${rel}.upstream (kept yours)`);
  }

  // 3. a clean namespace refreshes its base so the next update measures from here.
  if (!conflicts.length) snapshotBase({ srcPath, srcPacks: src, namespace, target });

  log(`  [${namespace}] took ${took} upstream · kept ${kept} local · added ${added} · ${conflicts.length} conflict(s)${conflicts.length ? ' — ' + conflicts.join('; ') : ''}`);
  return { namespace, took, kept, added, conflicts };
}

// Per-id three-way for a section's entries. Local order preserved; new upstream appended.
function mergeEntries({ base, local, upstream }) {
  const map = (arr) => new Map((arr || []).map((e) => [e.id, e]));
  const B = map(base), L = map(local), U = map(upstream);
  const merged = new Map(); const conflicts = [];
  let took = 0, kept = 0, added = 0;
  for (const id of new Set([...L.keys(), ...U.keys(), ...B.keys()])) {
    const b = B.get(id), l = L.get(id), u = U.get(id);
    if (l && u) {
      const lc = !b || canon(l) !== canon(b);            // local changed vs base
      const uc = !b || canon(u) !== canon(b);            // upstream changed vs base
      if (uc && !lc) { merged.set(id, u); took++; }       // take upstream
      else if (lc && !uc) { merged.set(id, l); kept++; }  // keep local
      else if (canon(l) === canon(u)) merged.set(id, l);  // identical / both-unchanged
      else { merged.set(id, l); conflicts.push(id); }     // both diverged → keep local, flag
    } else if (l && !u) merged.set(id, l);                // local-only entry
    else if (!l && u && !b) { merged.set(id, u); added++; } // genuinely-new upstream
    // (!l && u && b): deleted locally → respect the deletion, don't resurrect it
  }
  // stable order: local order first, then newly-added upstream ids
  const out = []; const seen = new Set();
  for (const e of (local || [])) if (merged.has(e.id)) { out.push(merged.get(e.id)); seen.add(e.id); }
  for (const e of (upstream || [])) if (merged.has(e.id) && !seen.has(e.id)) { out.push(merged.get(e.id)); seen.add(e.id); }
  return { merged: out, conflicts, took, kept, added };
}

// Three-way one script file. Returns 'clean' | 'conflict' | 'unchanged' | 'added'.
// Clean merges are written; a conflict leaves the live file untouched and drops a
// <file>.upstream sidecar (NEVER conflict markers — a marked rule silently stops enforcing).
function threeWayFile({ baseFile, localFile, upstreamFile }) {
  const local = readFileSync(localFile, 'utf8');
  const upstream = existsSync(upstreamFile) ? readFileSync(upstreamFile, 'utf8') : local;
  if (!existsSync(baseFile)) {                            // no base for this script → can't 3-way
    if (local === upstream) return 'unchanged';
    writeFileSync(`${localFile}.upstream`, upstream); return 'conflict';
  }
  const base = readFileSync(baseFile, 'utf8');
  if (upstream === base) return 'unchanged';              // upstream didn't move
  if (local === base) { writeFileSync(localFile, upstream); return 'clean'; } // only upstream moved → take it
  if (local === upstream) return 'unchanged';             // converged independently
  const tmp = mkdtempSync(join(tmpdir(), 'sg-merge-'));
  try {
    const mine = join(tmp, 'mine'), b = join(tmp, 'base'), u = join(tmp, 'up');
    writeFileSync(mine, local); writeFileSync(b, base); writeFileSync(u, upstream);
    const r = spawnSync('git', ['merge-file', '-p', mine, b, u], { encoding: 'utf8' }); // -p → stdout, don't overwrite
    if (r.status === 0) { writeFileSync(localFile, r.stdout); return 'clean'; }         // non-overlapping → merged
    writeFileSync(`${localFile}.upstream`, upstream); return 'conflict';                 // overlapping → keep local
  } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
}

// ── self-test ─────────────────────────────────────────────────────────────────
export function selfTest() {
  const fails = [];
  const ok = (n, c) => { if (!c) fails.push(n); };
  const root = mkdtempSync(join(tmpdir(), 'sg-refresh-'));
  const installFor = (hub, ns, app) => installPack({ source: hub, namespace: ns, target: app, log: () => {} });
  try {
    const hub = join(root, 'hub'), app = join(root, 'app');
    const write = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
    const script = (name, body) => `// ${name}\n${body}\nexport default { kind: 'content', evaluate() { return []; } };\n`;

    // hub v1
    write(join(hub, 'rules', 'demo', 'take.mjs'), script('take', 'const V = 1;'));
    write(join(hub, 'rules', 'demo', 'keep.mjs'), script('keep', 'const V = 1;'));
    write(join(hub, 'rules', 'demo', 'conflict.mjs'), script('conflict', 'const SAME_LINE = 1;'));
    write(join(hub, 'rules', 'demo', 'merge.mjs'), script('merge', ['const A = 1;', 'const B1 = 2;', 'const B2 = 2;', 'const B3 = 2;', 'const C = 3;'].join('\n')));
    write(join(hub, 'signposts.yaml'), [
      'rules:', '  demo:',
      '    - id: r-take',    '      use: demo/take',    '      on: ["a"]',
      '    - id: r-keep',    '      use: demo/keep',    '      on: ["a"]',
      '    - id: r-conflict', '      use: demo/conflict', '      on: ["a"]', '',
    ].join('\n'));
    // target with a signposts.yaml to receive the install
    write(join(app, 'signposts.yaml'), 'signs: {}\nrules: {}\npacks:\n  - "@signposts/core"\n');

    // install v1 (creates base + local copies + packs entry)
    installFor(hub, 'demo', app);

    // upstream v2: change take + conflict; leave keep
    write(join(hub, 'rules', 'demo', 'take.mjs'), script('take', 'const V = 2; // upstream'));
    write(join(hub, 'rules', 'demo', 'conflict.mjs'), script('conflict', 'const SAME_LINE = 999; // upstream'));
    write(join(hub, 'rules', 'demo', 'merge.mjs'), script('merge', ['const A = 100; // upstream', 'const B1 = 2;', 'const B2 = 2;', 'const B3 = 2;', 'const C = 3;'].join('\n')));
    write(join(hub, 'signposts.yaml'), [
      'rules:', '  demo:',
      '    - id: r-take',    '      use: demo/take',    '      on: ["UPSTREAM"]',
      '    - id: r-keep',    '      use: demo/keep',    '      on: ["a"]',
      '    - id: r-conflict', '      use: demo/conflict', '      on: ["UPSTREAM"]',
      '    - id: r-new',     '      use: demo/take',    '      on: ["a"]', '',      // genuinely new upstream id
    ].join('\n'));
    // local edits: change keep script + conflict script + r-keep entry + r-conflict entry
    write(join(app, 'rules', 'demo', 'keep.mjs'), script('keep', 'const V = 1; // LOCAL edit'));
    write(join(app, 'rules', 'demo', 'conflict.mjs'), script('conflict', 'const SAME_LINE = 7; // LOCAL'));
    write(join(app, 'rules', 'demo', 'merge.mjs'), script('merge', ['const A = 1;', 'const B1 = 2;', 'const B2 = 2;', 'const B3 = 2;', 'const C = 300; // LOCAL'].join('\n')));
    editYaml(join(app, 'signposts.yaml'), (doc) => {
      const rules = doc.toJS().rules.demo;
      const set = (id, on) => { const i = rules.findIndex((e) => e.id === id); doc.setIn(['rules', 'demo', i, 'on'], on); };
      set('r-keep', ['LOCAL']); set('r-conflict', ['LOCAL']);
    });

    const res = refresh({ target: app, log: () => {} }).packs.find((r) => r.namespace === 'demo');

    // scripts
    ok('take.mjs took upstream', readFileSync(join(app, 'rules', 'demo', 'take.mjs'), 'utf8').includes('V = 2'));
    ok('keep.mjs kept local', readFileSync(join(app, 'rules', 'demo', 'keep.mjs'), 'utf8').includes('LOCAL edit'));
    ok('conflict.mjs kept local (untouched)', readFileSync(join(app, 'rules', 'demo', 'conflict.mjs'), 'utf8').includes('= 7; // LOCAL'));
    ok('conflict.mjs wrote .upstream sidecar', existsSync(join(app, 'rules', 'demo', 'conflict.mjs.upstream')));
    ok('no conflict markers in the live file', !readFileSync(join(app, 'rules', 'demo', 'conflict.mjs'), 'utf8').includes('<<<<<<<'));
    // the whole reason git merge-file is shelled out: non-overlapping edits auto-merge, both survive.
    const mergedFile = readFileSync(join(app, 'rules', 'demo', 'merge.mjs'), 'utf8');
    ok('merge.mjs auto-merged both non-overlapping edits', mergedFile.includes('A = 100') && mergedFile.includes('C = 300'));
    ok('merge.mjs clean — no .upstream sidecar', !existsSync(join(app, 'rules', 'demo', 'merge.mjs.upstream')));
    // entries
    const rules = parseYaml(readFileSync(join(app, 'signposts.yaml'), 'utf8')).rules.demo;
    const byId = Object.fromEntries(rules.map((e) => [e.id, e]));
    ok('r-take took upstream', canon(byId['r-take'].on) === canon(['UPSTREAM']));
    ok('r-keep kept local', canon(byId['r-keep'].on) === canon(['LOCAL']));
    ok('r-conflict kept local', canon(byId['r-conflict'].on) === canon(['LOCAL']));
    ok('r-new added from upstream', !!byId['r-new']);
    ok('refresh reported conflicts', (res.conflicts || []).length >= 2); // conflict.mjs + rules/r-conflict
    ok('refresh took upstream updates', res.took >= 2);
    // skill surface: refresh re-copies SKILL.md/coach.md from the running package into the project.
    ok('refresh re-copied the skill surface', existsSync(join(app, '.claude', 'skills', 'signposts', 'SKILL.md')));

    // missing-base fallback
    const app2 = join(root, 'app2');
    write(join(app2, 'signposts.yaml'), 'signs: {}\nrules: {}\npacks:\n  - "@signposts/core"\n');
    installFor(hub, 'demo', app2);
    rmSync(join(app2, '.signposts'), { recursive: true, force: true }); // simulate fresh clone (gitignored base gone)
    const res2 = refresh({ target: app2, log: () => {} }).packs.find((r) => r.namespace === 'demo');
    ok('missing base → fallback flagged', res2.fallback === true);
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (fails.length) { console.error('FAIL refresh:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('PASS refresh (3-way: take · keep · conflict · new · missing-base; + skill surface)');
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--test') selfTest();
  else { console.error('usage: node src/cli/refresh.mjs --test'); process.exit(1); }
}
