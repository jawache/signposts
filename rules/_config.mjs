// rules/_config.mjs — the calling convention for rule configuration.
//
// One signposts.yaml at the repo root carries everything a bundle needs:
//   project:    bundle identity
//   config:     engine runtime config (drift_tokens)
//   advisory:   the proactive signs (rendered by the signposts.mjs hook)
//   rules:      per-rule parameters  ← THIS is what a parameterised rule reads
//   install:    files / devDeps / activation, consumed by `npx signposts`
//
// The contract for a check:
//   • the FILES to scan still arrive as positional path args (the lefthook contract:
//     `node rules/check-x.mjs <file> …`);
//   • the CONFIG comes from here — `ruleConfig('<rule-name>')` returns `rules.<name>`.
// Only IMPERATIVE rules (node / shell) use this. DECLARATIVE ast-grep rules don't —
// their pattern IS their config, so there's nothing to read at runtime.
//
// Fails safe: a missing/malformed signposts.yaml or section yields `{}`, so a rule
// without config behaves exactly as before (no config = its built-in defaults).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export function ruleConfig(name, root = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  try {
    const doc = parseYaml(readFileSync(join(root, 'signposts.yaml'), 'utf8')) || {};
    const rules = doc.rules;
    // Instance-list form (the engine schema): find the entry by id.
    if (Array.isArray(rules)) return rules.find((r) => r && r.id === name) || {};
    // Legacy map form: rules.<name>.
    return (rules && rules[name]) || {};
  } catch {
    return {};
  }
}
