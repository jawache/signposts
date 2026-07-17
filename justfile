# Command catalog — the SINGLE front door for every dev / test / rules task.
# `just` (no recipe) lists everything. ALL commands live here; package.json `scripts`
# is empty on purpose (one source of truth, enforced by the `no-package-scripts` rule).
# Every recipe needs a [doc("…")] (enforced by the `justfile-docs` rule). Both live in
# signposts.yaml and run through the engine (rules/_engine.mjs).
# Requires `just` (brew install just).

# Put repo-local CLIs (ast-grep…) on PATH for every recipe, so recipes call them by name.
export PATH := (justfile_directory() / "node_modules" / ".bin") + ":" + env_var("PATH")

[doc("Show the catalog.")]
default:
    @just --list

# ── setup ──────────────────────────────────────────────────────────────────────

# Run this FIRST in a fresh clone/worktree. A missing local dep silently falls back
# to whatever sits higher up the tree, which can crash hooks before their fail-safe
# catches it. `npm ci` installs exactly the lockfile's versions; then we point git at the
# committed .githooks/ (core.hooksPath is per-clone local config — each clone runs this once).
[doc("Install deps from the lockfile + arm the commit gate (core.hooksPath) — run first in a fresh clone/worktree.")]
install:
    npm ci
    git config core.hooksPath .githooks

[doc("Create a worktree for <branch> and open it in VS Code (worktrunk; pre-start hook copies ignored setup files, writes .wt-port, links .work).")]
worktree branch:
    wt switch -x code -c {{branch}}

[doc("Session orientation: current branch (with upstream), short working-tree status, and the diffstat vs main.")]
git-status:
    @git branch -vv | head -1
    @git status -s
    @git diff main...HEAD --stat

# ── rules / tests ──────────────────────────────────────────────────────────────

[doc("Unit-test the PURE decision layer: src/core/pure/*.mjs, each fn with a colocated .test.mjs (the functional core — no IO, no node builtins, fenced by fcis/pure-core).")]
test-pure:
    node --test "src/core/pure/*.test.mjs"

[doc("Coverage gate for the functional core: fails if src/core/pure/** line coverage drops below 95%.")]
test-coverage:
    node --test --experimental-test-coverage --test-coverage-include='src/core/pure/**' --test-coverage-exclude='src/core/pure/**/*.test.mjs' --test-coverage-lines=95 "src/core/pure/*.test.mjs"

[doc("Run every rules/ check + self-test: the pure decision layer, then the engine internals (adapters, shell contract, log, signs, session-report, pack-diff, source, install, refresh, the rule-test runner) then `signposts test` (every rule's .test.yml through the real engine + ast-grep validation).")]
test-rules: test-pure
    node src/schema.mjs --test && node src/engine.mjs --test && node src/log.mjs --test && node src/core/languages.mjs --test && node src/hooks/signs-core.mjs --test && node src/hooks/signs-test.mjs && node src/hooks/session-start.mjs --test && node src/skill/session-report.mjs --test && node src/skill/pack-diff.mjs --test && node src/skill/detect.mjs --test && node src/skill/rule-test.mjs --test && node src/cli/source.mjs --test && node src/cli/install.mjs --test && node src/cli/languages.mjs --test && node src/cli/refresh.mjs --test && node src/cli/signposts.mjs test

[doc("Prove it works AS-INSTALLED: npm pack -> temp install -> drive the real CLI (packaging, scaffold, the gate, ship-completeness, onboarding-steers).")]
test-e2e:
    node --test "test/e2e/*.test.mjs"

[doc("Drive the real moment hooks (session-start, signs) with their exact JSON payloads and assert output + drift-state. No human, no token cost.")]
test-hooks:
    node --test "test/hooks/*.test.mjs"

[doc("LIVE tier: drive a real agent headlessly (claude --bare -p) and assert the streamed hook_response + folder state. Needs ANTHROPIC_API_KEY and spends tokens — NOT in the default gate.")]
test-live:
    node --test "test/live/*.test.mjs"

[doc("The COMMIT gate's test set: everything deterministic and fast (~6s) — the rule self-tests + the hook-moment tests. Skips the ~19s as-installed e2e and the token-spending live tier. This is what commit-runs-tests runs.")]
test-commit: test-rules test-hooks

[doc("Run every test — the in-repo rule self-tests, the hook-moment tests, and the as-installed e2e suite. (Live tier is separate: `just test-live`.) This is the CI/full run.")]
test: test-rules test-hooks test-e2e

[doc("Run the full commit gate against ALL tracked files (not just staged) — the engine at --phase commit.")]
gate:
    node src/engine.mjs --phase commit $(git ls-files)

# ── website (site/) ─────────────────────────────────────────────────────────────

# The site is a STANDALONE npm project in site/ (not a workspace of this root package —
# the root is the publishable signposts CLI). Recipes cd in and drive its own npm scripts.
[doc("Run the website dev server (Astro, site/) at http://localhost:4321.")]
site-dev:
    cd site && npm run dev

[doc("Build the website (site/) to site/dist — static output for Cloudflare.")]
site-build:
    cd site && npm run build

[doc("Type-check the website (site/) — astro check (tsc on .ts + the Astro language server on .astro).")]
site-check:
    cd site && npm run check
