// rules/_config.mjs — read a single rule's config out of signposts.yaml by id.
//
// The engine hands each script its config VERBATIM (the whole `rules:` entry), so
// most scripts never need this. It's for a script's OWN standalone CLI (run outside
// the engine, e.g. `node rules/justfile/justfile-docs.mjs <files>`) that still wants to
// read its params from the one config file.
//
// `rules:` is GROUPED BY NAMESPACE (namespace → [entries]); this searches across all
// namespaces for the entry whose `id` matches.
//
// Fails safe: a missing/malformed signposts.yaml or section yields `{}`, so a script
// with no config behaves exactly as it would with its built-in defaults.

import { ruleById } from './schema.mjs';

// Delegates to the shared normaliser so a standalone script CLI reads the SAME shape
// (bundle-first or section-first) the engine does, and gets the entry moment-normalised.
export function ruleConfig(name, root = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  return ruleById(name, root);
}
