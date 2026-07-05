// rules/core/tool-gate.mjs — run a whole-project tool, block on failure.
//
// The one tool-delegated rule. Some checks need the whole tree in a consistent
// state (a transitive import boundary, coverage, the type graph) — they can't run
// per keystroke, so a tool-gate is commit/push only (set when: [commit]). The TOOL
// owns its config file; Signposts orchestrates (run + block) and vendors that file
// via `carries:` so the rule travels as one unit.
//
// Config:  run: "npx depcruise src --config .dependency-cruiser.cjs"
// Contract: kind 'project' → ctx = { root } (nothing per-file).

import { spawnSync } from 'node:child_process';

export default {
  kind: 'project',
  evaluate(rule, ctx) {
    const r = spawnSync('bash', ['-lc', rule.run], { cwd: ctx.root, encoding: 'utf8' });
    if (r.status === 0) return [];
    return [`tool-gate failed (exit ${r.status}): ${rule.run}\n${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n')}`];
  },
  test() {
    const root = process.cwd();
    const legal = this.evaluate({ run: 'true' }, { root }).length === 0;
    const illegal = this.evaluate({ run: 'exit 3' }, { root }).length === 1;
    return { name: 'core/tool-gate', pass: legal && illegal };
  },
};
