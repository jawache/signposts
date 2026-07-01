// rules/_config.mjs — read a single rule's config out of signposts.yaml by id.
//
// The engine hands each script its config VERBATIM (the whole `rules:` entry), so
// most scripts never need this. It's for a script's OWN standalone CLI (run outside
// the engine, e.g. `node rules/local/justfile-docs.mjs <files>`) that still wants to
// read its params from the one config file.
//
// `rules:` is GROUPED BY NAMESPACE (namespace → [entries]); this searches across all
// namespaces for the entry whose `id` matches.
//
// Fails safe: a missing/malformed signposts.yaml or section yields `{}`, so a script
// with no config behaves exactly as it would with its built-in defaults.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export function ruleConfig(name, root = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  try {
    const doc = parseYaml(readFileSync(join(root, 'signposts.yaml'), 'utf8')) || {};
    const rules = doc.rules;
    // Grouped form (namespace → [entries]): search every namespace for the id.
    if (rules && typeof rules === 'object' && !Array.isArray(rules)) {
      for (const list of Object.values(rules)) {
        if (!Array.isArray(list)) continue;
        const hit = list.find((r) => r && r.id === name);
        if (hit) return hit;
      }
      return {};
    }
    // Tolerate a legacy flat list.
    if (Array.isArray(rules)) return rules.find((r) => r && r.id === name) || {};
    return {};
  } catch {
    return {};
  }
}
