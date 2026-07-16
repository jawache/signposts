#!/usr/bin/env node
// .claude/skills/signposts/pack-diff.mjs — the deterministic fact-provider for `/signposts install`.
//
// Point it at another repo (your hub, a teammate's project, a pack) and it diffs
// THEIR signposts against YOURS, per namespace, for both signs: and rules::
//   • new       — an id you don't have in that namespace
//   • collision — an id you both have, but the entry differs
//   • same      — an id you both have, identical
// It also lists the script files each namespace ships (rules/<ns>/…), so install
// knows what to copy. Facts only — the picking + collision calls are the skill's job.
//
//   node .claude/skills/signposts/pack-diff.mjs <source-repo> [--target <dir>] [--namespace <ns>] [--json]
//   node .claude/skills/signposts/pack-diff.mjs --test

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDoc } from '../schema.mjs';

// A3 (honesty): the legacy flat layout (`advisory:`, or `signs:`/`rules:` as a bare array)
// carries no namespaces, so a diff of it finds nothing — the same "(no installable namespaces)"
// as an empty repo. Detect it so we can say WHY. Mirrors install.mjs's refusal check.
export function isLegacyDoc(doc) {
  return !!doc && (doc.advisory !== undefined || Array.isArray(doc.signs) || Array.isArray(doc.rules));
}

// ── load a repo's packs (grouped: namespace → [entries]) via the shared normaliser, so a
//    BUNDLE-FIRST source diffs exactly like a section-first one (bundle name = namespace), and
//    both sides are moment-normalised so `at:` vs legacy `when:` never masquerades as a diff.
export function loadPacks(root) {
  const c = loadConfig(root);
  // The normaliser buckets a legacy FLAT list under the '' namespace (namespace-less). A pack is
  // a named unit, so drop it — a legacy-layout source then reads as "no installable namespaces"
  // and the diff explains WHY (via `legacy`), instead of inventing an unnamed pack.
  const named = (g) => Object.fromEntries(Object.entries(g).filter(([ns]) => ns !== ''));
  return { signs: named(c.signs), rules: named(c.rules), settings: named(c.settings), root, legacy: isLegacyDoc(loadDoc(root)) };
}

// stable stringify (sorted keys) so formatting never masquerades as a difference.
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',')}}`;
  return JSON.stringify(v);
}

// ── diff source packs against target packs ────────────────────────────────────
export function diffPacks(source, target, only) {
  const report = { signs: {}, rules: {}, namespaces: {}, sourceLegacy: !!source.legacy };
  for (const section of ['signs', 'rules']) {
    for (const [ns, entries] of Object.entries(source[section])) {
      if (only && ns !== only) continue;
      const mine = new Map((target[section][ns] || []).map((e) => [e.id, e]));
      const bucket = { new: [], collision: [], same: [] };
      for (const e of entries) {
        if (!mine.has(e.id)) bucket.new.push(e.id);
        else if (canon(mine.get(e.id)) === canon(e)) bucket.same.push(e.id);
        else bucket.collision.push(e.id);
      }
      report[section][ns] = bucket;
      const n = (report.namespaces[ns] ||= { signs: 0, rules: 0, scripts: [] });
      n[section] = entries.length;
    }
  }
  // scripts each namespace ships (rules/<ns>/…), for the copy step
  for (const ns of Object.keys(report.namespaces)) {
    report.namespaces[ns].scripts = listScripts(source.root, ns, only);
  }
  return report;
}

function listScripts(root, ns) {
  const dir = join(root, 'rules', ns);
  const out = [];
  const walk = (d) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(root, p));
    }
  };
  walk(dir);
  return out;
}

// ── render (human) ────────────────────────────────────────────────────────────
function render(report, source, target) {
  const L = [`pack diff — ${source} → ${target}`, ''];
  const namespaces = Object.keys(report.namespaces).sort();
  if (!namespaces.length) {
    if (report.sourceLegacy) L.push('legacy flat format detected (advisory: / bare signs: / rules: array) — install can\'t read it; it needs a manual port. Open it with the /signposts skill and cherry-pick by hand.');
    else L.push('(no installable namespaces found in the source)');
    return L.join('\n');
  }
  for (const ns of namespaces) {
    const meta = report.namespaces[ns];
    L.push(`▸ ${ns}  (${meta.signs || 0} sign(s), ${meta.rules || 0} rule(s), ${meta.scripts.length} script file(s))`);
    for (const section of ['signs', 'rules']) {
      const b = report[section][ns]; if (!b) continue;
      const parts = [];
      if (b.new.length) parts.push(`new: ${b.new.join(', ')}`);
      if (b.collision.length) parts.push(`COLLIDE: ${b.collision.join(', ')}`);
      if (b.same.length) parts.push(`same: ${b.same.length}`);
      if (parts.length) L.push(`    ${section}: ${parts.join('  ·  ')}`);
    }
  }
  L.push('', 'Legend: new = take freely · COLLIDE = you both have it, differing (decide) · same = already have.');
  return L.join('\n');
}

// ── self-test ─────────────────────────────────────────────────────────────────
function selfTest() {
  const src = {
    root: '/src',
    signs: { neon: [{ id: 'migrations', globs: ['db/**'], text: 'append-only' }] },
    rules: { neon: [
      { id: 'no-raw-pool', use: 'neon/no-raw-pool', on: 'src/**' },   // new
      { id: 'shared', use: 'core/text-ban', ban: 'X' },               // collides (mine differs)
      { id: 'agreed', use: 'core/text-ban', ban: 'Y' },               // same
    ] },
  };
  const tgt = {
    root: '/tgt',
    signs: {},
    rules: { neon: [
      { id: 'shared', use: 'core/text-ban', ban: 'DIFFERENT' },
      { id: 'agreed', use: 'core/text-ban', ban: 'Y' },
    ] },
  };
  const r = diffPacks(src, tgt);
  const checks = [
    ['sign new', canon(r.signs.neon.new) === canon(['migrations'])],
    ['rule new', canon(r.rules.neon.new) === canon(['no-raw-pool'])],
    ['rule collision', canon(r.rules.neon.collision) === canon(['shared'])],
    ['rule same', canon(r.rules.neon.same) === canon(['agreed'])],
    ['namespace counts', r.namespaces.neon.rules === 3 && r.namespaces.neon.signs === 1],
    ['canon order-insensitive', canon({ a: 1, b: 2 }) === canon({ b: 2, a: 1 })],
    // A3: legacy flat layouts are detected, and the empty-diff render says WHY.
    ['legacy: advisory key', isLegacyDoc({ advisory: [] }) === true],
    ['legacy: flat rules array', isLegacyDoc({ rules: [{ id: 'x' }] }) === true],
    ['not legacy: grouped', isLegacyDoc({ rules: { core: [] } }) === false],
    ['legacy hint on empty diff', render({ signs: {}, rules: {}, namespaces: {}, sourceLegacy: true }, '/s', '/t').includes('legacy flat format')],
    ['plain hint when not legacy', render({ signs: {}, rules: {}, namespaces: {}, sourceLegacy: false }, '/s', '/t').includes('no installable namespaces')],
  ];
  const fail = checks.filter(([, ok]) => !ok).map(([n]) => n);
  if (fail.length) { console.error('FAIL pack-diff:\n  ' + fail.join('\n  ')); process.exit(1); }
  console.log(`PASS pack-diff (${checks.length} checks)`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--test')) { selfTest(); process.exit(0); }
  const getArg = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const sourceArg = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--target' && argv[argv.indexOf(a) - 1] !== '--namespace');
  if (!sourceArg) { console.error('usage: node .claude/skills/signposts/pack-diff.mjs <source-repo> [--target <dir>] [--namespace <ns>] [--json]'); process.exit(1); }
  const source = resolve(sourceArg);
  const target = resolve(getArg('--target') || process.cwd());
  const only = getArg('--namespace');
  if (!existsSync(join(source, 'signposts.yaml'))) { console.error(`no signposts.yaml in ${source}`); process.exit(1); }
  const report = diffPacks(loadPacks(source), loadPacks(target), only);
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(render(report, source, target));
}
