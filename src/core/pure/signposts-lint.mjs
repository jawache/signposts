// src/core/pure/signposts-lint.mjs — PURE decision: walk a PARSED signposts doc and return the
// required-field violations. No IO / no YAML parse — the adapter (../signposts-lint.mjs) parses the
// file and calls this. Handles the current bundle-first shape and the legacy shapes.

const RESERVED = new Set(['project', 'config', 'signs', 'rules', 'settings', 'advisory', 'packs', 'install', 'bundles']);

export function lint(doc, required = ['description']) {
  if (!doc || typeof doc !== 'object') return ['signposts file is empty or not a mapping'];
  const need = [].concat(required);
  const hits = [];
  const check = (kind, ns, entry, i) => {
    const id = entry && entry.id;
    const where = `${kind} ${ns ? `${ns}/` : ''}${id || `#${i + 1}`}`;
    if (!entry || typeof entry !== 'object') { hits.push(`${where}: not a mapping`); return; }
    if (!id) hits.push(`${where}: missing an id`);
    if (kind === 'rule' && !entry.use) hits.push(`${where}: a rule must name a script with use:`);
    for (const f of need) {
      const v = entry[f];
      if (v == null || String(v).trim() === '') hits.push(`${where}: missing ${f}`);
    }
  };
  const walk = (ns, block) => {
    if (!block || typeof block !== 'object') return;
    // current shape: a `signposts:` list of typed signposts.
    (Array.isArray(block.signposts) ? block.signposts : []).forEach((e, i) => {
      const kind = e && e.type === 'sign' ? 'sign' : e && e.type === 'rule' ? 'rule' : null;
      if (!kind) hits.push(`signpost ${ns}/${(e && e.id) || `#${i + 1}`}: missing or unknown \`type\` (expected sign | rule)`);
      else check(kind, ns, e, i);
    });
    // legacy grouped-inside-a-bundle.
    if (Array.isArray(block.signs)) block.signs.forEach((e, i) => check('sign', ns, e, i));
    if (Array.isArray(block.rules)) block.rules.forEach((e, i) => check('rule', ns, e, i));
  };
  // current shape: every non-reserved top-level key is a bundle.
  for (const [ns, b] of Object.entries(doc)) {
    if (RESERVED.has(ns) || !b || typeof b !== 'object' || Array.isArray(b)) continue;
    walk(ns, b);
  }
  // legacy `bundles:` wrapper.
  if (doc.bundles && typeof doc.bundles === 'object' && !Array.isArray(doc.bundles)) {
    for (const [ns, b] of Object.entries(doc.bundles)) walk(ns, b);
  }
  // legacy section-first: signs.<ns>[] / rules.<ns>[].
  for (const kind of ['signs', 'rules']) {
    const g = doc[kind];
    if (g && typeof g === 'object' && !Array.isArray(g)) {
      for (const [ns, list] of Object.entries(g)) if (Array.isArray(list)) list.forEach((e, i) => check(kind.slice(0, -1), ns, e, i));
    }
  }
  return hits;
}
