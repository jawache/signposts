---
name: review
description: ALWAYS invoke when the user signals end of session ("wrap up", "/review", "let's wrap this up", "we're done").
allowed-tools: Read, Edit, Write, Grep, Glob, Bash(git log *), Bash(git diff *), Bash(git show *), Bash(git status), Bash(node .claude/skills/review/session-report.mjs *), Task, AskUserQuestion
---

# Review

The keystone skill. Closes a session: **deterministic facts → parallel read-only reviews →
one HTML field-guide (`wrap-up.html`) you decide on → main thread applies → ticks state.**

## Principles

1. **Reviewers are read-only and RETURN their findings to the main thread — they write NO
   files.** The main thread (which has live context) synthesises them, *you* decide what
   to adopt, then the main thread applies. There are no per-agent markdown files anymore.
2. **Recommendations-or-silence.** Every reviewer surfaces only what should *change*. No
   "this is fine", no praise, no empty sections, no tiers. If a lens has nothing, it says
   nothing.
3. **One artefact.** `wrap-up.html` is the whole record — your mental-model, the adopt/skip
   decisions, the deploy notes `/release` reads, and the stats. No `.md` twin, nothing else.
4. **The spec stays frozen** — review reads `spec.html`, never edits it. State is folder
   location, which `/work complete` moves; review never moves folders.
5. **Never commit, push, or tag.** Wrap-up produces files; the user commits.

---

## Step 1 — Pre-flight (scope)

- **Active work folder** — the current branch's `/work` folder: `.work/tasks/ready/<branch-path>/`
  (`git branch --show-current` → the path; else look under `tasks/backlog/`). `{folder}` below means
  this. If unclear, ask. None → *Exploratory mode* (bottom).
- **Diff range:** `git merge-base HEAD <base>`..HEAD, where `<base>` is the working branch
  (`dev`, else `master`/`main`).
- One-line scope summary (spec · commit count · files touched). Confirm before proceeding.

## Step 2 — Facts pre-pass (deterministic)

Run the skill's own parser, `node .claude/skills/review/session-report.mjs`. Capture the facts
report — it gives **coach** its numbers (hook fires/outcomes, justfile hit-rate, signpost
coverage) and an **`ops footprint`** flag (devops always runs, but uses this to know whether
it has anything to report). This is the deterministic measurement layer; the agents reason
over it, they don't recompute it.

## Step 3 — Spawn the reviewers (parallel, read-only, return-to-main)

Spawn in parallel. Pass each the **slug + diff range**; pass **coach the facts report**.
Each agent **returns** its findings as its final message — none writes a file.

| Agent | Lens | Run when |
|---|---|---|
| `secops` | security must-fix | always |
| `codeops` | simpler code + its tests (QA) | always |
| `docops` | docs/comments made untrue | always |
| `coach` | is the signposts machinery working (hooks/justfile/signposts) | always |
| `devops` | deploy-notes for the release step | always (returns "none" when the diff has no DB/infra footprint) |

Collect all returned findings.

## Step 4 — Synthesise `wrap-up.html` (main thread)

Author `{folder}/wrap-up.html` from `templates/wrap-up.html` — optimised for *the user* to
build a mental model and make decisions:

- **What was done** — the session's changes, grouped and scannable (your own context + the
  diff/git log). Plus any key decisions made in flight.
- **Recommendations** — *one* consolidated, de-duplicated decision list across all
  reviewers, severity-ordered (secops must-fix first). Each row: lens · a plain-English
  title · **why it matters** (the consequence) · the `file:line` detail *second* · your
  recommended disposition (Adopt / Skip + one-line why).
- **Deploy notes** — devops always runs; include its checklist, or "no operational footprint" if it returned none.

> **The plain-English bar — non-negotiable.** The reviewers write in expert shorthand for
> *you* (the main thread), not the user — "the green-commit path", "globs", "`execSync`
> interpolation", "gitFacts". Before a recommendation lands in `wrap-up.html`, **rewrite it so
> a tech-literate reader who has never seen this codebase can decide adopt/skip from it
> alone**: name the thing, say what it *is*, say why it matters as a *consequence* (define any
> code-internal noun inline), and put the `file:line` / mechanism **last**, for the curious.
> If a finding proposes a **rule/check**, never give the lint name — say "a check that *does
> X in plain words*, catching *a concrete example*". The test for every row: *could someone
> outside this repo judge it?* If not, it isn't ready — rewrite it.

Hand it over. This drives the conversation.

## Step 5 — Decide (the user)

The user reads `wrap-up.html` and says what to adopt. **Wait.** Don't apply anything yet.

## Step 6 — Apply the approved changes (main thread)

Apply only what the user accepted, verbatim where the reviewer gave exact text:

- **coach** → `signposts.yaml` edits. **New `rules/` checks are NOT auto-added** — they're a
  deliberate `/signposts` operationalisation; surface, don't apply.
- **docops** → comment / doc-truth fixes.
- **codeops** → simplifications / missing tests.
- **secops** → action the must-fixes, or surface them for the user.

Everything stays uncommitted — the user reviews via `git diff`.

## Step 7 — Finalise `wrap-up.html` (main thread)

- **`{folder}/wrap-up.html`** — record the outcome in the file you already wrote: flip each
  recommendation's Adopt/Skip pill to what the user chose, and fill the **Stats** line
  (commits · files · +X/−Y · hooks / justfile / signpost coverage, from the facts report).
  The **Deploy notes** section is what `/release` reads — keep it accurate (or "No
  operational footprint"). It's the single record, no `.md` twin. If the feature spans
  several review sessions, carry forward any deploy notes that haven't shipped yet.
- **State is folders, not flags.** Review doesn't move the work folder or tick a backlog —
  that's `/work complete` (run after this). Review's output is `wrap-up.html`, full stop.

## Step 8 — Report card

Short: wrapped `{slug}`; scope (`N commits, M files`); `wrap-up.html` path; recommendations
adopted / skipped; deploy-notes captured (or none); outstanding. End with: *"All changes
are uncommitted — review with `git diff` and commit when ready."*

---

## Exploratory mode

No active spec → skip the reviewers and the artefacts entirely; just report the files
touched + commits in the report card. Ask up front: *"This session has no active spec —
exploratory wrap-up? (skip reviews)"*
