// cli/install.mjs — `npx signposts install <source> [namespace]`.
//
// Resolve the source (git / npm / local) → diff its packs against mine → copy a chosen
// namespace: its rules/<ns>/ scripts + its signs:/rules: groups, MERGE any host-permission
// entries it carries into .claude/settings.json, and record the source (+ what it owns) in
// packs: so `refresh` / `uninstall` can track it. signposts.yaml IS the manifest.
//
//   npx signposts install github:you/neon            # browse: list namespaces + the diff
//   npx signposts install github:you/neon  neon      # take the neon namespace
//
// Deterministic + non-destructive: it takes NEW entries and copies scripts, but never
// clobbers a COLLISION — it reports those and points at `/signposts install` (the skill).
// YAML writes go through parseDocument (editYaml) so the user's comments survive intact.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify as stringifyYaml } from 'yaml';
import { resolveSource } from './source.mjs';
import { loadPacks, diffPacks } from '../skill/pack-diff.mjs';

export function installPack({ source, namespace, target = process.cwd(), log = console.log }) {
  const resolved = resolveSource(source);
  assertInstallableSchema(resolved.path);                // current layout only — old repos go through the skill
  const src = loadPacks(resolved.path);
  const tgt = loadPacks(target);
  const report = diffPacks(src, tgt, namespace);
  const namespaces = Object.keys(report.namespaces).sort();

  if (!namespace) {                                    // browse mode
    log(`Source ${source} offers ${namespaces.length} namespace(s):`);
    for (const ns of namespaces) {
      const m = report.namespaces[ns];
      const nw = (report.signs[ns]?.new.length || 0) + (report.rules[ns]?.new.length || 0);
      const perms = src.settings?.[ns]?.permissions;
      const permNote = perms && (perms.deny?.length || perms.allow?.length) ? ', carries host-permissions' : '';
      log(`  • ${ns}  (${m.signs || 0} sign(s), ${m.rules || 0} rule(s); ${nw} new to you${permNote})`);
    }
    log(`\nInstall one with:  npx signposts install ${source} <namespace>`);
    return { namespaces, installed: null };
  }

  if (!namespaces.includes(namespace)) { log(`Namespace "${namespace}" not found in ${source}. Available: ${namespaces.join(', ') || '(none)'}`); return { installed: null }; }

  const result = applyNamespace({ srcPath: resolved.path, srcPacks: src, namespace, target, report, log });
  // Host permissions: reads + MCP tool calls the engine never sees, enforced by the host.
  const ledger = mergePermissions(target, src.settings?.[namespace]?.permissions);
  addPackEntry(target, source, { namespaces: [namespace], settings: ledger });
  snapshotBase({ srcPath: resolved.path, srcPacks: src, namespace, target }); // arm refresh's 3-way merge
  log(`\n✓ installed ${namespace} from ${source}: ${result.scripts} script(s), ${result.added} entr(y/ies) added, ${result.collisions.length} collision(s) skipped.`);
  if (ledger) log(`  merged host permissions into .claude/settings.json: ${[...(ledger.deny || []), ...(ledger.allow || [])].join(', ')}`);
  if (result.collisions.length) log(`  Collisions (kept yours): ${result.collisions.join(', ')} — resolve with \`/signposts install\`.`);
  log(`  Tracked in packs: → \`npx signposts refresh\` will keep it updated · \`npx signposts uninstall --pack ${namespace}\` removes it.`);
  return { installed: namespace, ...result, settings: ledger };
}

// Copy a namespace's scripts + merge its NEW entries into the target signposts.yaml.
// Collisions are reported, never overwritten. Returns { scripts, added, collisions }.
export function applyNamespace({ srcPath, srcPacks, namespace, target, report, log = () => {} }) {
  // 1. copy rules/<ns>/ scripts
  const scriptDir = join(srcPath, 'rules', namespace);
  let scripts = 0;
  if (existsSync(scriptDir)) for (const rel of walk(scriptDir, srcPath)) { copyInto(join(srcPath, rel), join(target, rel)); scripts++; log(`  copied  ${rel}`); }

  // 2. merge NEW entries of both sections (skip collisions) — comment-preserving.
  let added = 0; const collisions = [];
  const block = (n) => { n.flow = false; return n; };      // force block style (scaffold seeds `signs: {}` as flow)
  editYaml(join(target, 'signposts.yaml'), (doc) => {
    const js = doc.toJS() || {};
    for (const section of ['signs', 'rules']) {
      const incoming = srcPacks[section][namespace] || [];
      if (!incoming.length) continue;
      const bucket = report[section][namespace] || { new: [], collision: [] };
      const have = new Set((js[section]?.[namespace] || []).map((e) => e.id));
      // reset an empty (flow `{}`) section to a block map so additions render as clean block YAML.
      if (doc.getIn([section]) == null || Object.keys(js[section] || {}).length === 0) doc.setIn([section], block(doc.createNode({})));
      if (doc.getIn([section, namespace]) == null) doc.setIn([section, namespace], block(doc.createNode([])));
      for (const e of incoming) {
        if (bucket.collision.includes(e.id)) { collisions.push(`${section}/${e.id}`); continue; }
        if (have.has(e.id)) continue;                    // identical → already there
        doc.addIn([section, namespace], block(doc.createNode(e))); added++; log(`  + ${section}.${namespace}.${e.id}`);
      }
    }
  });
  return { scripts, added, collisions };
}

// Edit signposts.yaml WITHOUT destroying the user's comments. `parseYaml`→`stringifyYaml`
// drops every comment; `parseDocument` round-trips them. fn mutates the Document (setIn /
// addIn / getIn / deleteIn); we write doc.toString(). This is the ONLY way YAML is written
// from here on (the executor note: never `stringifyYaml(parseYaml(...))`).
export function editYaml(path, fn) {
  const doc = parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : '');
  if (doc.contents == null) doc.contents = doc.createNode({});
  fn(doc);
  // lineWidth:0 stops long messages/regexes being folded across lines; flowCollectionPadding:false
  // keeps arrays as ["x"] not [ "x" ] — together they hold the diff to the intended additions.
  writeFileSync(path, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
}

// Merge a namespace's host-permission entries into .claude/settings.json (the host
// enforces reads + MCP tool calls our engine never sees). Returns the pack's DECLARED
// set as a ledger — EXACTLY what uninstall must remove — or null if none.
function mergePermissions(target, perms) {
  if (!perms || (!perms.deny?.length && !perms.allow?.length)) return null;
  const path = join(target, '.claude', 'settings.json');
  const cfg = existsSync(path) ? (safeJson(readFileSync(path, 'utf8')) || {}) : {};
  cfg.permissions ||= {};
  const ledger = {};
  for (const kind of ['deny', 'allow']) {
    const incoming = perms[kind] || [];
    if (!incoming.length) continue;
    cfg.permissions[kind] ||= [];
    for (const entry of incoming) if (!cfg.permissions[kind].includes(entry)) cfg.permissions[kind].push(entry);
    ledger[kind] = [...incoming];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  return ledger;
}

// Record the pack in packs: as an OBJECT entry: source + namespaces + settings ledger +
// install date. Plain-string entries (legacy) remain valid; installing a second namespace
// from the same source MERGES into the existing entry. Comment-preserving.
function addPackEntry(target, spec, { namespaces = [], settings = null } = {}) {
  editYaml(join(target, 'signposts.yaml'), (doc) => {
    if (doc.getIn(['packs']) == null) doc.setIn(['packs'], doc.createNode([]));
    const arr = (doc.toJS() || {}).packs || [];        // node.toJS() needs the doc; read via the Document
    const idx = arr.findIndex((p) => (typeof p === 'string' ? p : p?.source) === spec);
    const prev = idx >= 0 && typeof arr[idx] === 'object' ? arr[idx] : null;
    const entry = {
      source: spec,
      namespaces: [...new Set([...(prev?.namespaces || []), ...namespaces])],
      ...mergeLedger(prev?.settings, settings),
      installed: today(),
    };
    if (idx >= 0) doc.setIn(['packs', idx], doc.createNode(entry));
    else doc.addIn(['packs'], doc.createNode(entry));
  });
}
// Union two {deny,allow} ledgers into { settings: {...} } (or {} if empty).
function mergeLedger(a, b) {
  const out = {};
  for (const kind of ['deny', 'allow']) {
    const merged = [...new Set([...((a && a[kind]) || []), ...((b && b[kind]) || [])])];
    if (merged.length) (out.settings ||= {})[kind] = merged;
  }
  return out;
}

function today() { return new Date().toISOString().slice(0, 10); }
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// install reads only the CURRENT layout: namespace-grouped signs:/rules: maps. A legacy
// source (flat lists, or the old `advisory:` key for signs) is refused with a clear pointer
// to the skill — there is NO auto-normalisation (decided), so a broken half-install can't happen.
function assertInstallableSchema(srcPath) {
  let doc;
  try { doc = parseDocument(readFileSync(join(srcPath, 'signposts.yaml'), 'utf8')).toJS() || {}; } catch { return; }
  const legacy = doc.advisory !== undefined || Array.isArray(doc.signs) || Array.isArray(doc.rules);
  if (legacy) throw new Error(`${srcPath} uses an older signposts layout — install can't read it. Open it with the /signposts skill instead and cherry-pick by hand.`);
}

// Snapshot what the pack shipped THIS install → .signposts/base/<ns>/ (gitignored), so
// refresh can three-way merge later. Scripts verbatim (mirroring rules/<ns>/…) + the
// namespace's yaml slice as _entries.yaml (machine-owned → plain stringify, comments N/A).
export function snapshotBase({ srcPath, srcPacks, namespace, target }) {
  const baseDir = join(target, '.signposts', 'base', namespace);
  mkdirSync(baseDir, { recursive: true });
  const scriptDir = join(srcPath, 'rules', namespace);
  if (existsSync(scriptDir)) for (const rel of walk(scriptDir, srcPath)) copyInto(join(srcPath, rel), join(baseDir, rel));
  const slice = { signs: srcPacks.signs[namespace] || [], rules: srcPacks.rules[namespace] || [], settings: srcPacks.settings?.[namespace] || {} };
  writeFileSync(join(baseDir, '_entries.yaml'), stringifyYaml(slice));
}

// ── fs helpers ────────────────────────────────────────────────────────────────
export function walk(absDir, root) {
  const out = [];
  const rec = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const ab = join(d, e.name); e.isDirectory() ? rec(ab) : out.push(relative(root, ab)); } };
  rec(absDir);
  return out;
}
export function copyInto(srcFile, dstFile) {
  mkdirSync(dirname(dstFile), { recursive: true });
  writeFileSync(dstFile, readFileSync(srcFile), { mode: statSync(srcFile).mode });
}

// ── self-test (temp-dir fixtures: a source pack + a commented target) ───────────
export function selfTest() {
  const fails = [];
  const ok = (name, cond) => { if (!cond) fails.push(name); };
  const root = mkdtempSync(join(tmpdir(), 'sg-install-'));
  try {
    // a source pack: namespace `neon` with a sign, a rule, a script, and a host-permission.
    const srcDir = join(root, 'hub');
    mkdirSync(join(srcDir, 'rules', 'neon'), { recursive: true });
    writeFileSync(join(srcDir, 'rules', 'neon', 'no-raw-pool.mjs'), 'export default { kind: "content", evaluate(){ return []; } };\n');
    writeFileSync(join(srcDir, 'signposts.yaml'), [
      'signs:', '  neon:', '    - id: db-area', '      globs: ["src/db/**"]', '      text: append-only',
      'rules:', '  neon:', '    - id: no-raw-pool', '      use: neon/no-raw-pool', '      on: ["src/**"]',
      'settings:', '  neon:', '    permissions:', '      deny: ["Read(./.env.keys)"]', '',
    ].join('\n'));

    // a target with a HEAVILY-COMMENTED signposts.yaml + a hand-written settings.json deny.
    const tgtDir = join(root, 'app');
    mkdirSync(join(tgtDir, '.claude'), { recursive: true });
    const marker = '# KEEP-THIS-COMMENT — user authored';
    writeFileSync(join(tgtDir, 'signposts.yaml'), [
      marker, 'project:', '  name: app   # inline comment kept too',
      'signs: {}', 'rules: {}', 'packs:', '  - "@signposts/core"', '',
    ].join('\n'));
    writeFileSync(join(tgtDir, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(./secrets/**)'] } }, null, 2) + '\n');

    installPack({ source: srcDir, namespace: 'neon', target: tgtDir, log: () => {} });

    const outYaml = readFileSync(join(tgtDir, 'signposts.yaml'), 'utf8');
    ok('comments survive an install merge', outYaml.includes(marker) && outYaml.includes('inline comment kept too'));
    const doc = parseDocument(outYaml).toJS();
    ok('sign merged into namespace', doc.signs?.neon?.some((e) => e.id === 'db-area'));
    ok('rule merged into namespace', doc.rules?.neon?.some((e) => e.id === 'no-raw-pool'));
    ok('script copied', existsSync(join(tgtDir, 'rules', 'neon', 'no-raw-pool.mjs')));
    const packEntry = (doc.packs || []).find((p) => typeof p === 'object' && p.source === srcDir);
    ok('packs: object entry written', !!packEntry && packEntry.namespaces.includes('neon'));
    ok('provenance records the settings ledger', packEntry?.settings?.deny?.includes('Read(./.env.keys)'));
    ok('legacy string pack entry preserved', (doc.packs || []).includes('@signposts/core'));
    const set = JSON.parse(readFileSync(join(tgtDir, '.claude', 'settings.json'), 'utf8'));
    ok('pack permission merged into settings.json', set.permissions.deny.includes('Read(./.env.keys)'));
    ok('hand-written permission untouched', set.permissions.deny.includes('Read(./secrets/**)'));

    // a legacy-schema source (old `advisory:` key) is refused with a clear pointer — no half-install.
    const legacyDir = join(root, 'legacy');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'signposts.yaml'), 'advisory:\n  - id: old\n    globs: ["x"]\n    text: legacy\n');
    let threw = '';
    try { installPack({ source: legacyDir, namespace: 'x', target: tgtDir, log: () => {} }); } catch (e) { threw = e.message; }
    ok('legacy-schema source refused with skill pointer', /older signposts layout/.test(threw) && /\/signposts skill/.test(threw));

    // round-trip: uninstall --pack removes exactly the pack's footprint (in the --test main).
    return { root, srcDir, tgtDir, ok, fails };
  } catch (e) {
    fails.push(`threw: ${e.message}`);
    return { root, fails, ok: () => {} };
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--test') {
    // install-side assertions + the uninstall round-trip (kept here so one --test covers both).
    import('./uninstall.mjs').then(({ uninstallPack }) => {
      const { root, tgtDir, ok, fails } = selfTest();
      try {
        if (tgtDir) {
          uninstallPack({ target: tgtDir, namespace: 'neon', log: () => {} });
          const doc = parseDocument(readFileSync(join(tgtDir, 'signposts.yaml'), 'utf8')).toJS();
          ok('uninstall removed the rule group', !doc.rules?.neon);
          ok('uninstall removed the sign group', !doc.signs?.neon);
          ok('uninstall pruned the packs entry', !(doc.packs || []).some((p) => typeof p === 'object' && (p.namespaces || []).includes('neon')));
          ok('uninstall kept the legacy string entry', (doc.packs || []).includes('@signposts/core'));
          ok('uninstall removed rules/neon/', !existsSync(join(tgtDir, 'rules', 'neon')));
          const set = JSON.parse(readFileSync(join(tgtDir, '.claude', 'settings.json'), 'utf8'));
          ok('uninstall removed the pack permission', !set.permissions.deny.includes('Read(./.env.keys)'));
          ok('uninstall kept the hand-written permission', set.permissions.deny.includes('Read(./secrets/**)'));
        }
      } finally {
        try { rmSync(root, { recursive: true, force: true }); } catch {}
      }
      if (fails.length) { console.error('FAIL install:\n  ' + fails.join('\n  ')); process.exit(1); }
      console.log('PASS install (round-trip: merge + provenance + comments + uninstall)');
    });
  } else { console.error('usage: node src/cli/install.mjs --test'); process.exit(1); }
}
