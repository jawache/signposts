// src/core/change-together.mjs — files that must move in the SAME commit.
//
// Some edits are only correct in pairs: change package.json and the lockfile changes too; touch a
// schema and its migration ships alongside. This project-kind rule reads the staged set at commit
// and blocks when a trigger changed but its companion didn't.
//
// Config:  groups:
//            - if: ["package.json"]                 # any staged file matching an `if` glob …
//              then-any: ["package-lock.json", "pnpm-lock.yaml"]   # … needs a staged `then-any` too
// Contract: kind 'project' → ctx = { root }. The staged set arrives from `git diff --cached`
// (ctx.changed overrides it in tests). Fails safe: not a git repo / unreadable → [] (can't judge →
// never traps a commit).

import { spawnSync } from 'node:child_process';
import { globMatch } from '../hooks/signs-core.mjs';

// Pure: which groups were triggered (an `if` glob changed) without their `then-any` companion?
export function changeTogether({ changed, groups }) {
  const out = [];
  for (const g of [].concat(groups || [])) {
    const ifGlobs = [].concat(g.if || []);
    const thenGlobs = [].concat(g['then-any'] || g.thenAny || []);
    const triggered = changed.some((f) => ifGlobs.some((glob) => globMatch(glob, f)));
    if (!triggered) continue;
    const satisfied = changed.some((f) => thenGlobs.some((glob) => globMatch(glob, f)));
    if (!satisfied) out.push(`${ifGlobs.join(', ')} changed but none of [${thenGlobs.join(', ')}] did in the same commit`);
  }
  return out;
}

// The staged file set (paths relative to the repo root). null = not a git repo / git unavailable.
function stagedFiles(root) {
  try {
    const r = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) return null;
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return null; }
}

export default {
  kind: 'project',
  evaluate(rule, ctx) {
    const changed = ctx.changed ?? stagedFiles(ctx.root);
    if (!changed) return [];                                   // can't tell → never trap
    return changeTogether({ changed, groups: rule.groups });
  },
  test() {
    const groups = [{ if: ['package.json'], 'then-any': ['package-lock.json', 'pnpm-lock.yaml'] }];
    const ev = (changed) => this.evaluate({ groups }, { changed });
    const lonely = ev(['package.json', 'src/x.mjs']).length === 1;          // trigger, no companion → block
    const paired = ev(['package.json', 'package-lock.json']).length === 0;  // both → clear
    const untriggered = ev(['src/x.mjs', 'README.md']).length === 0;        // no trigger → clear
    const safe = this.evaluate({ groups }, { root: '/nonexistent-xyz' }).length === 0; // no repo → never trap
    return { name: 'core/change-together', pass: lonely && paired && untriggered && safe };
  },
};
