// cli/install.mjs — `npx signposts install <source> [namespace]`.
//
// Resolve the source (git / npm / local) → diff its packs against mine → copy a chosen
// namespace: its rules/<ns>/ scripts + its signs:/rules: groups, and record the source
// in packs: so `refresh` can track it. signposts.yaml IS the manifest — no pack format.
//
//   npx signposts install github:you/neon            # browse: list namespaces + the diff
//   npx signposts install github:you/neon  neon      # take the neon namespace
//
// Deterministic + non-destructive: it takes NEW entries and copies scripts, but never
// clobbers a COLLISION — it reports those and points at `/signposts install` (the skill),
// which resolves clashes in conversation.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveSource } from './source.mjs';
import { loadPacks, diffPacks } from '../.claude/skills/signposts/pack-diff.mjs';

export function installPack({ source, namespace, target = process.cwd(), log = console.log }) {
  const resolved = resolveSource(source);
  const src = loadPacks(resolved.path);
  const tgt = loadPacks(target);
  const report = diffPacks(src, tgt, namespace);
  const namespaces = Object.keys(report.namespaces).sort();

  if (!namespace) {                                    // browse mode
    log(`Source ${source} offers ${namespaces.length} namespace(s):`);
    for (const ns of namespaces) {
      const m = report.namespaces[ns];
      const nw = (report.signs[ns]?.new.length || 0) + (report.rules[ns]?.new.length || 0);
      log(`  • ${ns}  (${m.signs || 0} sign(s), ${m.rules || 0} rule(s); ${nw} new to you)`);
    }
    log(`\nInstall one with:  npx signposts install ${source} <namespace>`);
    return { namespaces, installed: null };
  }

  if (!namespaces.includes(namespace)) { log(`Namespace "${namespace}" not found in ${source}. Available: ${namespaces.join(', ') || '(none)'}`); return { installed: null }; }

  const result = applyNamespace({ srcPath: resolved.path, srcPacks: src, namespace, target, report, log });
  addPackEntry(target, source);
  log(`\n✓ installed ${namespace} from ${source}: ${result.scripts} script(s), ${result.added} entr(y/ies) added, ${result.collisions.length} collision(s) skipped.`);
  if (result.collisions.length) log(`  Collisions (kept yours): ${result.collisions.join(', ')} — resolve with \`/signposts install\`.`);
  log(`  Tracked in packs: → \`npx signposts refresh\` will keep it updated.`);
  return { installed: namespace, ...result };
}

// Copy a namespace's scripts + merge its NEW entries into the target signposts.yaml.
// Collisions are reported, never overwritten. Returns { scripts, added, collisions }.
export function applyNamespace({ srcPath, srcPacks, namespace, target, report, log = () => {} }) {
  // 1. copy rules/<ns>/ scripts
  const scriptDir = join(srcPath, 'rules', namespace);
  let scripts = 0;
  if (existsSync(scriptDir)) for (const rel of walk(scriptDir, srcPath)) { copyInto(join(srcPath, rel), join(target, rel)); scripts++; log(`  copied  ${rel}`); }

  // 2. merge NEW entries of both sections (skip collisions)
  const doc = existsSync(join(target, 'signposts.yaml')) ? parseYaml(readFileSync(join(target, 'signposts.yaml'), 'utf8')) || {} : {};
  let added = 0; const collisions = [];
  for (const section of ['signs', 'rules']) {
    const incoming = srcPacks[section][namespace] || [];
    if (!incoming.length) continue;
    const bucket = report[section][namespace] || { new: [], collision: [] };
    doc[section] ||= {}; doc[section][namespace] ||= [];
    const have = new Set(doc[section][namespace].map((e) => e.id));
    for (const e of incoming) {
      if (bucket.collision.includes(e.id)) { collisions.push(`${section}/${e.id}`); continue; }
      if (have.has(e.id)) continue;                    // identical → already there
      doc[section][namespace].push(e); added++; log(`  + ${section}.${namespace}.${e.id}`);
    }
  }
  writeFileSync(join(target, 'signposts.yaml'), stringifyYaml(doc));
  return { scripts, added, collisions };
}

function addPackEntry(target, spec) {
  const p = join(target, 'signposts.yaml');
  const doc = existsSync(p) ? parseYaml(readFileSync(p, 'utf8')) || {} : {};
  doc.packs = [...new Set([...(doc.packs || []), spec])];
  writeFileSync(p, stringifyYaml(doc));
}

// ── fs helpers ────────────────────────────────────────────────────────────────
function walk(absDir, root) {
  const out = [];
  const rec = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const ab = join(d, e.name); e.isDirectory() ? rec(ab) : out.push(relative(root, ab)); } };
  rec(absDir);
  return out;
}
function copyInto(srcFile, dstFile) {
  mkdirSync(dirname(dstFile), { recursive: true });
  writeFileSync(dstFile, readFileSync(srcFile), { mode: statSync(srcFile).mode });
}
