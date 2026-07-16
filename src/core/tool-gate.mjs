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

// Git exports these to a hook's environment; they REDIRECT any nested `git` command to the
// parent repo (a `git init` in a temp dir would suddenly write the real index). A tool-gate runs
// at commit-time (via the pre-commit hook), so it inherits them — strip them so the tool it runs
// (a test suite, a linter) is hermetic and can't corrupt or trip over the in-progress commit.
const GIT_HOOK_ENV = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR', 'GIT_INDEX_VERSION', 'GIT_QUARANTINE_PATH', 'GIT_QUARANTINE_ID'];
function hermeticEnv() {
  const env = { ...process.env };
  for (const k of GIT_HOOK_ENV) delete env[k];
  return env;
}

export default {
  kind: 'project',
  evaluate(rule, ctx) {
    const r = spawnSync('bash', ['-lc', rule.run], { cwd: ctx.root, encoding: 'utf8', env: hermeticEnv() });
    if (r.status === 0) return [];
    return [`tool-gate failed (exit ${r.status}): ${rule.run}\n${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n')}`];
  },
  test() {
    const root = process.cwd();
    const legal = this.evaluate({ run: 'true' }, { root }).length === 0;
    const illegal = this.evaluate({ run: 'exit 3' }, { root }).length === 1;
    // hermetic: even with a git-hook env var set, the spawned tool doesn't see it
    process.env.GIT_DIR = '/some/parent/.git';
    const scrubbed = this.evaluate({ run: '[ -z "$GIT_DIR" ]' }, { root }).length === 0;
    delete process.env.GIT_DIR;
    return { name: 'core/tool-gate', pass: legal && illegal && scrubbed };
  },
};
