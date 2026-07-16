// src/schema.mjs — the ONE load-time normaliser every reader consumes.
//
// signposts.yaml has two shapes and the engine only wants one. This file accepts:
//   • BUNDLE-FIRST (v2) — `bundles: { <name>: { from, signs, rules, settings, needs } }`,
//     each bundle a contiguous block; the bundle name IS the namespace.
//   • SECTION-FIRST (v1, still supported forever) — top-level `signs:` / `rules:` /
//     `settings:`, grouped by namespace (or a legacy flat list, or `advisory:`).
// …and hands every consumer the FLAT, grouped-by-namespace form the runtime already eats.
//
// It also speaks the MOMENT vocabulary as sugar over the internal phase names:
//   • signs   `at: session|touch|turn`   (default touch);  `global: true` ≡ `at: session`.
//   • rules   `at: write|commit|delete|turn`  (default [write, commit]);  legacy `when:`
//     (internal edit|commit|delete|push) is accepted as-is.  `write` ⇢ internal phase `edit`.
// An unknown moment is an honest warning and the entry is skipped — never a throw.
//
// FAILS SAFE like every rail: a missing / malformed file yields empty config, never raises.

import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';

const THRESHOLD = 200_000;

// Authoring moment → internal engine phase. `write` is the human word for the pre-emptive
// PreToolUse block, which the engine has always called `edit`. The rest pass straight through,
// including the legacy internal names so an old `when: [edit, commit]` still normalises to itself.
const RULE_MOMENTS = { write: 'edit', edit: 'edit', commit: 'commit', delete: 'delete', push: 'push', turn: 'turn' };
const SIGN_MOMENTS = new Set(['session', 'touch', 'turn']);

// ── per-entry normalisation ────────────────────────────────────────────────────

// Rule: fold `at:` / `when:` (or the default) into the internal `when` phase list the
// engine filters on. Returns the entry with `when` set (and `at` stripped), or null if it
// names a moment we don't recognise (caller drops it + records the warning).
export function normaliseRule(r, warnings = []) {
  if (!r || typeof r !== 'object') return null;
  const raw = r.at != null ? r.at : (r.when != null ? r.when : ['write', 'commit']);
  const when = [];
  for (const m of [].concat(raw)) {
    const phase = RULE_MOMENTS[m];
    if (!phase) { warnings.push(`rule '${r.id ?? '?'}': unknown moment '${m}' — entry skipped`); return null; }
    if (!when.includes(phase)) when.push(phase);
  }
  const { at: _at, when: _when, ...rest } = r;
  return { ...rest, when };
}

// Sign: fold `at:` / `global:` (or the default `touch`) into a canonical `at`, and keep the
// legacy `global` flag in lockstep with `at: session` so the existing PostToolUse injector
// (signs-core `matchScore`, which keys off `global`) fires a session sign exactly as before —
// until the SessionStart delivery lands. Returns null on an unknown moment.
export function normaliseSign(s, warnings = []) {
  if (!s || typeof s !== 'object') return null;
  const at = s.at || (s.global ? 'session' : 'touch');
  if (!SIGN_MOMENTS.has(at)) { warnings.push(`sign '${s.id ?? '?'}': unknown moment '${at}' — entry skipped`); return null; }
  const out = { ...s, at };
  if (at === 'session') out.global = true;
  return out;
}

// ── whole-document normalisation ───────────────────────────────────────────────

// Coerce a section value into grouped `{ ns: [entries] }`. Already-grouped objects pass
// through; a legacy flat list lands under the '' namespace (namespace-less, as the engine's
// old flat fallback treated it).
function groupSection(raw) {
  if (Array.isArray(raw)) return { '': raw };
  if (raw && typeof raw === 'object') {
    const out = {};
    for (const [ns, list] of Object.entries(raw)) if (Array.isArray(list)) out[ns] = list;
    return out;
  }
  return {};
}

// The heart: raw parsed YAML → `{ project, config, signs, rules, settings, bundles, warnings }`
// where signs/rules are grouped-by-namespace and every entry is moment-normalised. Pure.
export function normalizeDoc(doc) {
  const warnings = [];
  const d = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc
    : Array.isArray(doc) ? { signs: doc }                    // whole-doc-array legacy → flat signs
    : {};

  const signs = {};
  const rules = {};
  const settings = {};
  const bundles = {};

  const addSigns = (ns, list) => {
    for (const s of list || []) {
      if (!s || !s.id) continue;
      const n = normaliseSign(s, warnings);
      if (n) (signs[ns] ||= []).push(n);
    }
  };
  const addRules = (ns, list) => {
    for (const r of list || []) {
      const n = normaliseRule(r, warnings);
      if (n) (rules[ns] ||= []).push(n);
    }
  };

  // 1. bundle-first: each bundle contributes to its own namespace.
  if (d.bundles && typeof d.bundles === 'object' && !Array.isArray(d.bundles)) {
    for (const [ns, b] of Object.entries(d.bundles)) {
      if (!b || typeof b !== 'object') continue;
      addSigns(ns, b.signs);
      addRules(ns, b.rules);
      if (b.settings) settings[ns] = b.settings;
      bundles[ns] = { from: b.from ?? null, needs: b.needs ?? null };  // provenance/meta (consumed in P6)
    }
  }

  // 2. section-first (also merged, so a hybrid file still loads): existing namespaces win.
  for (const [ns, list] of Object.entries(groupSection(d.signs ?? d.advisory))) addSigns(ns, list);
  for (const [ns, list] of Object.entries(groupSection(d.rules))) addRules(ns, list);
  if (d.settings && typeof d.settings === 'object' && !Array.isArray(d.settings)) {
    for (const [ns, v] of Object.entries(d.settings)) if (!(ns in settings)) settings[ns] = v;
  }

  return { project: d.project || {}, config: d.config || {}, signs, rules, settings, bundles, warnings };
}

// ── the off switch: one marker every rail checks first ─────────────────────────
// `.signposts/off` (gitignored) nullifies the WHOLE system — no sign injection, no
// pre-emptive block, no command guard, no commit gate. Every rail calls isOff() first and
// bails instantly, so an A/B run (rails on vs off) needs no settings surgery. Fail-safe:
// any error reading the marker → treat as ON, so a filesystem hiccup can't silence the gate.
export function offMarkerPath(root = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  return join(root, '.signposts', 'off');
}
export function isOff(root = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  try { return existsSync(offMarkerPath(root)); } catch { return false; }
}

// ── loaders + flatteners the runtime calls ─────────────────────────────────────

// Parse signposts.yaml once (fail-safe → {}).
export function loadDoc(root, configPath) {
  try { return parseYaml(readFileSync(configPath || join(root, 'signposts.yaml'), 'utf8')) || {}; }
  catch { return {}; }
}

// The normalised config for a repo.
export function loadConfig(root, configPath) {
  return normalizeDoc(loadDoc(root, configPath));
}

// Flatten grouped signs to the ordered list signs-core consumes (YAML order, id required). Pure.
export function flattenSigns(config) {
  return Object.values(config.signs).flat().filter((e) => e && e.id);
}

// Flatten grouped rules to the engine's flat array, re-attaching `namespace` (undefined for the
// legacy flat group). `use`-less entries are dropped, as the engine has always done. Pure.
export function flattenRules(config) {
  const out = [];
  for (const [ns, list] of Object.entries(config.rules))
    for (const r of list) if (r && r.use) out.push({ ...r, namespace: ns || undefined });
  return out;
}

// signs.mjs replacement for loadMap: { signs, drift }.
export function loadSigns(root, configPath) {
  const c = loadConfig(root, configPath);
  return { signs: flattenSigns(c), drift: Number(c.config && c.config.drift_tokens) || THRESHOLD };
}

// engine.mjs replacement for `rules:` step-1: the flat, namespaced, when-defaulted rule list.
export function loadRuleEntries(root, configPath) {
  return flattenRules(loadConfig(root, configPath));
}

// config.mjs replacement for ruleConfig: a single rule entry by id (or {}).
export function ruleById(name, root, configPath) {
  for (const list of Object.values(loadConfig(root, configPath).rules)) {
    const hit = list.find((r) => r && r.id === name);
    if (hit) return hit;
  }
  return {};
}

// ── self-test (pure; run by `just test-rules`) ─────────────────────────────────

function selfTest() {
  const cases = [];
  // Compare order-insensitively on object keys (semantics, not insertion order): the two yaml
  // shapes yield the same key/value pairs but may insert `at` vs `global` in a different order.
  const stable = (v) => Array.isArray(v) ? v.map(stable)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))
    : v;
  const check = (name, got, want) => cases.push([name, JSON.stringify(stable(got)) === JSON.stringify(stable(want)), got, want]);

  // 1. Both shapes normalise to identical flat config.
  const sectionDoc = {
    project: { name: 'app' },
    config: { drift_tokens: 1000 },
    signs: { core: [{ id: 'orient', global: true, text: 'hi' }, { id: 'lib', globs: ['src/lib/**'], text: 'lib' }] },
    rules: { core: [{ id: 'no-scripts', use: 'core/json-invariant', on: 'package.json' }] },
    settings: { core: { permissions: { deny: ['Read(.env.keys)'] } } },
  };
  const bundleDoc = {
    project: { name: 'app' },
    config: { drift_tokens: 1000 },
    bundles: {
      core: {
        signs: [{ id: 'orient', at: 'session', text: 'hi' }, { id: 'lib', globs: ['src/lib/**'], text: 'lib' }],
        rules: [{ id: 'no-scripts', use: 'core/json-invariant', on: 'package.json' }],
        settings: { permissions: { deny: ['Read(.env.keys)'] } },
      },
    },
  };
  const cs = normalizeDoc(sectionDoc);
  const cb = normalizeDoc(bundleDoc);
  check('both shapes → identical flat rules', flattenRules(cb), flattenRules(cs));
  check('both shapes → identical flat signs', flattenSigns(cb), flattenSigns(cs));
  check('both shapes → identical settings', cb.settings, cs.settings);

  // 2. `at:` sugar table.
  check('sign global:true ⇢ at:session (+ global kept)', normaliseSign({ id: 's', global: true }), { id: 's', global: true, at: 'session' });
  check('sign at:session ⇢ global:true', normaliseSign({ id: 's', at: 'session' }).global, true);
  check('sign default ⇢ at:touch, not global', normaliseSign({ id: 's', globs: ['x'] }).at, 'touch');
  check('rule at:write ⇢ when [edit]', normaliseRule({ id: 'r', use: 'u', at: 'write' }).when, ['edit']);
  check('rule at:[write,commit] ⇢ [edit,commit]', normaliseRule({ id: 'r', use: 'u', at: ['write', 'commit'] }).when, ['edit', 'commit']);
  check('rule default ⇢ [edit,commit]', normaliseRule({ id: 'r', use: 'u' }).when, ['edit', 'commit']);
  check('rule legacy when:[commit] passthrough', normaliseRule({ id: 'r', use: 'u', when: ['commit'] }).when, ['commit']);
  check('rule at:turn ⇢ [turn]', normaliseRule({ id: 'r', use: 'u', at: 'turn' }).when, ['turn']);

  // 3. Unknown moment → warning + entry skipped.
  const w1 = [];
  check('rule unknown moment → null', normaliseRule({ id: 'r', use: 'u', at: 'whenever' }, w1), null);
  check('rule unknown moment → warns', w1.length, 1);
  const w2 = [];
  check('sign unknown moment → null', normaliseSign({ id: 's', at: 'always' }, w2), null);
  check('sign unknown moment → warns', w2.length, 1);
  const skipDoc = normalizeDoc({ rules: { core: [{ id: 'ok', use: 'u' }, { id: 'bad', use: 'u', at: 'nope' }] } });
  check('skipped entry absent, sibling kept', flattenRules(skipDoc).map((r) => r.id), ['ok']);
  check('doc surfaces the warning', skipDoc.warnings.length, 1);

  // 4. drift + failsafe.
  check('config.drift_tokens carried', normalizeDoc(sectionDoc).config.drift_tokens, 1000);
  check('malformed doc → empty, no throw', normalizeDoc('garbage'), { project: {}, config: {}, signs: {}, rules: {}, settings: {}, bundles: {}, warnings: [] });
  check('bundle from: recorded', normalizeDoc({ bundles: { fcis: { from: 'github:x#v1' } } }).bundles.fcis.from, 'github:x#v1');

  // 5. off marker: isOff true only when .signposts/off exists.
  const offRoot = mkdtempSync(join(tmpdir(), 'sg-off-'));
  try {
    check('isOff false when no marker', isOff(offRoot), false);
    mkdirSync(join(offRoot, '.signposts'), { recursive: true });
    writeFileSync(offMarkerPath(offRoot), 'off\n');
    check('isOff true when marker present', isOff(offRoot), true);
    rmSync(offMarkerPath(offRoot));
    check('isOff false again once removed', isOff(offRoot), false);
  } finally { rmSync(offRoot, { recursive: true, force: true }); }

  let pass = 0;
  for (const [name, ok, got, want] of cases) {
    if (ok) pass++;
    else console.log(`  ✗ ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
  const allOk = pass === cases.length;
  console.log(`${allOk ? 'PASS' : 'FAIL'} schema  (${pass}/${cases.length})`);
  process.exit(allOk ? 0 : 1);
}

if (process.argv[1]?.endsWith('schema.mjs') && process.argv[2] === '--test') selfTest();
