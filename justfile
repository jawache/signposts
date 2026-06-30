# Command catalog — the SINGLE front door for every dev / test / rules task.
# `just` (no recipe) lists everything. ALL commands live here; package.json `scripts`
# is empty on purpose (one source of truth, enforced by the `no-package-scripts` rule).
# Every recipe needs a [doc("…")] (enforced by the `justfile-docs` rule). Both live in
# signposts.yaml and run through the category engine (rules/_engine.mjs).
# Requires `just` (brew install just).

# Put repo-local CLIs (ast-grep, lefthook…) on PATH for every recipe, so recipes call them by name.
export PATH := (justfile_directory() / "node_modules" / ".bin") + ":" + env_var("PATH")

[doc("Show the catalog.")]
default:
    @just --list

# ── setup ──────────────────────────────────────────────────────────────────────

# Run this FIRST in a fresh clone/worktree. A missing local dep silently falls back
# to whatever sits higher up the tree, which can crash hooks before their fail-safe
# catches it. `npm ci` installs exactly the lockfile's versions; lefthook's postinstall
# then writes the .git/hooks/* shims (this is what arms the commit gate).
[doc("Install dependencies from the lockfile — run this first in a fresh clone/worktree.")]
install:
    npm ci

# ── rules / tests ──────────────────────────────────────────────────────────────

[doc("Run every rules/ check + self-test (ast-grep, category-engine, no-package-scripts, justfile-docs, git-discard, the signposts engine + session-report).")]
test-rules:
    ast-grep test --skip-snapshot-tests && node rules/_engine.mjs --test && node rules/check-justfile-docs.mjs --test && node rules/check-git-discard.mjs --test && node .claude/hooks/signposts-core.mjs --test && node .claude/hooks/signposts-test.mjs && node .claude/skills/signposts/session-report.mjs --test

[doc("Run the full commit gate against all files (what lefthook runs pre-commit).")]
gate:
    npx lefthook run pre-commit --all-files
