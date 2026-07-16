// src/core/change-together.mjs — ADAPTER: files that must move in the SAME commit.
// The decision is pure (./pure/change-together.mjs); this reads the staged set and calls it.
//
// Config:  groups:
//            - if: ["package.json"]                 # any staged file matching an `if` glob …
//              then-any: ["package-lock.json", "pnpm-lock.yaml"]   # … needs a staged `then-any` too
// Contract: kind 'project' → ctx = { root }. The staged set arrives from `git diff --cached`
// (ctx.changed overrides it in tests). Fails safe: not a git repo / unreadable → [] (never traps).

import { spawnSync } from 'node:child_process';
import { changeTogether } from './pure/change-together.mjs';
export { changeTogether };

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
