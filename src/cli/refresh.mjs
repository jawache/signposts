// cli/refresh.mjs — `npx signposts refresh` pulls updates for installed packs.
//
// In the dependency model the CORE updates via npm (`npm update signposts`) — there's
// no vendored engine to three-way-merge. What refresh handles is the installed PACKS:
// the sources in your `packs:` list (git / npm / local). It re-resolves each and, for
// every namespace you share with it, pulls new entries + the latest scripts. A locally
// diverged entry (a collision) is kept, never clobbered.

import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PACK_NAME, readText } from './pack.mjs';
import { resolveSource } from './source.mjs';
import { loadPacks, diffPacks } from '../skill/pack-diff.mjs';
import { applyNamespace } from './install.mjs';

export function refresh({ target = process.cwd(), log = console.log }) {
  log(`[${PACK_NAME}] the core ships in the signposts package — run \`npm update signposts\` to update it.`);
  const results = refreshInstalledPacks(target, log);
  const added = results.reduce((a, r) => a + (r.added || 0), 0);
  const conflicts = results.reduce((a, r) => a + ((r.collisions || []).length), 0);
  log(`\nInstalled packs: ${results.length} source(s), ${added} entr(y/ies) pulled, ${conflicts} collision(s) kept.`);
  return { packs: results };
}

// Re-resolve every source in packs: (git / npm / local) and pull namespace updates:
// new entries + latest scripts land; a locally-diverged entry (a collision) is kept.
function refreshInstalledPacks(target, log) {
  const doc = (() => { try { return parseYaml(readText(join(target, 'signposts.yaml'))) || {}; } catch { return {}; } })();
  const specs = (doc.packs || []).filter((s) => s && s !== PACK_NAME && !/@signposts\/core/.test(s));
  if (!specs.length) { log('  (no installed packs to refresh)'); return []; }
  const out = [];
  for (const spec of specs) {
    let resolved;
    try { resolved = resolveSource(spec); } catch (e) { log(`! ${spec}: ${e.message}`); out.push({ spec, error: e.message }); continue; }
    const src = loadPacks(resolved.path);
    const tgt = loadPacks(target);
    const shared = new Set([...Object.keys(src.signs), ...Object.keys(src.rules)].filter((ns) => (tgt.signs[ns] || tgt.rules[ns])));
    let added = 0, scripts = 0; const collisions = [];
    for (const ns of shared) {
      const report = diffPacks(src, tgt, ns);
      const r = applyNamespace({ srcPath: resolved.path, srcPacks: src, namespace: ns, target, report });
      added += r.added; scripts += r.scripts; collisions.push(...r.collisions);
    }
    log(`[${spec}] ${[...shared].join(', ') || '(no shared ns)'}: ${added} added, ${scripts} script(s), ${collisions.length} collision(s) kept`);
    out.push({ spec, namespaces: [...shared], added, scripts, collisions });
  }
  return out;
}
