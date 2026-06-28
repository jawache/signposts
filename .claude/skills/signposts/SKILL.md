---
name: signposts
description: ALWAYS invoke when the user says "/signposts", "/signposts audit", "audit this session", "operationalise this", "make this a rule", "add a rule", "add a signpost", "enforce this", "document this decision", "update architecture.md", or wants to author / test / validate a rule or a signpost.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(ls *), Bash(just test-rules*), Bash(ast-grep test*), Bash(node rules/*), Bash(node .claude/skills/signposts/session-report.mjs *), Task
---

# Signposts

This is the signpost-authoring skill. It operationalises a decision so it survives memory: it turns "we should always X" into a signpost the project *enforces* (a rule — an enforced signpost), *shapes* (an advisory signpost), or at least *records*.

**You run cold.** You're usually invoked in a fresh chat or worktree with no prior context — that's deliberate: signposts work is split out from the feature that triggered it so it lands clean. Take the problem statement, orient from `docs/arch/architecture.md` + `signposts.yaml` + `rules/README.md`, and locate the area you're governing. Don't assume a conversation you can't see.

## The model — three homes for a decision

Every decision that matters lands in one (or more) of:

- **Enforced** — a `rules/` check that *blocks* at edit-time + commit-time. Use when it's mechanically checkable (a file/command trigger, an AST pattern). The strongest home: it can't rot silently.
- **Shaped** — a `signposts.yaml` entry that *injects guidance* when you touch the area. For shape, judgement, and constraints no check can make. Soft: it nudges, doesn't block.
- **Recorded** — a one-line entry in `architecture.md` pointing at the rule/signpost/recipe that backs it. Use when the *why* could be undone by a future-you who forgot it.

Most decisions are a rule **or** a signpost, plus the recording line. **Prefer a rule whenever it's checkable** — a signpost for something a check could catch is hope, not enforcement.

## Flow — author a signpost

`signposts.yaml` (repo root) is the proactive surface — it replaced the old per-directory `AGENTS.md` files. A sign is delivered the moment you touch a matching path or run a matching command.

1. **Write the entry** — `id` + a matcher + a payload:
   - matcher: `globs: ["src/lib/foo/**"]` (path) or `commands: ["wrangler"]` (Bash-command substring).
   - payload: inline `text: |-` (a note) or `file: PATH` (inject a file's live contents).
   - optional: `global: true` (always inject) · `drift_tokens: N` (override the re-inject cadence).
2. **Apply the inclusion rule** — a line earns its place only if all three hold:
   - **Local** — specific to this area (global → `architecture.md` / `CLAUDE.md`).
   - **Not otherwise caught** — *drop it if a check enforces it* (the check is its home); if it's obvious from the exemplar; or if it's in `architecture.md` (link, don't restate).
   - **Proactive-load-bearing** — knowing it up front changes the first attempt.

   **Omit anything a check enforces — not even a pointer.** No "(enforced)", "this is checked", "see rules/". The one allowed inverse: flagging something as *not* enforced / on-you, to mark a judgement call.
3. **Test** — `just test-rules` (runs `signposts-core.mjs --test` + `signposts-test.mjs`). If you add a new matcher kind or cadence behaviour, add a case there.

## Flow — author a rule

The hard tier. **`rules/README.md` is the source of truth for *how*** — read it; don't restate it. The catalogue at a glance:

| Rule shape | Tool | Lives |
|---|---|---|
| TS/TSX AST pattern | ast-grep | `rules/ast-grep/*.yml` |
| Astro structure | ast-grep + grammar | `rules/ast-grep/*.yml` (+ `rules/grammars/*`) |
| Cross-statement / filesystem logic | node/bash `check-*.{mjs,sh}` | `rules/` |

1. **Write the check** at the right shape. **Name the decision in its error message** so a trip explains itself and points back.
2. **Ship a `--test`** — every `check-*.{mjs,sh}` exports pure logic + a self-test fired by `--test`; ast-grep `.yml` carry `ast-grep test` cases. Mirror an existing check.
3. **Wire it** into `lefthook.yml` (agent-edit for the fast file-local pass, pre-commit for the full gate), and add its `--test` to the `test-rules` recipe in the `justfile`.
4. **Test** — `just test-rules` green.

## Flow — record the decision

Append a 1–2 sentence entry to `architecture.md`'s `## Decisions`, in the house format: **Name** — what's true, one line. *Enforced:* the rule / signpost / recipe that backs it. Rationale lives in git history, not here. Skip this for routine work — it's for decisions a future-you might undo without remembering why.

## Flow — audit the session (`/signposts audit`)

The **detector** half of the loop: surface where the machinery let drift slip through *this* session, then dispose of each finding via the authoring flows above. Reads the session transcript, **not** a git diff — so it's runnable any time, with no active spec.

1. **Gather facts.** `node .claude/skills/signposts/session-report.mjs` from the repo root — deterministic stats + a navigable drift index (hook fires/outcomes, justfile bypasses, signpost-coverage gaps, course-corrections) over the newest session transcript. `--around <line>` opens any cited spot.
2. **Spawn coach** (Task) with that facts report. It reads the cited lines and returns candidate **`rules/` checks** + **`signposts.yaml`** entries — each a place the machinery let the agent go wrong. Coach writes nothing.
3. **Dispose.** For each candidate worth keeping, build it properly via the flows above — a rule (prefer it when checkable), a signpost (advisory), or a recorded decision. Rejecting one is fine; say why.
4. **Test** — `just test-rules` green for anything you added.

When `/review` wraps a session it **chains this audit**, so the process verdict lands every time; run it standalone here whenever you want a mid-session check.

## Graduated enforcement

A problem starts soft (a signpost — allow + nudge) and graduates hard (a rule — block) if it's persistently ignored. **coach** is the *detector* — run by `/signposts audit` (above) over the session facts, it flags "this leaked — it should be a rule" or "this signpost line". `/signposts` is the *disposer*: you take that proposal and build it properly here. Two ends of **one** loop, now under **one** skill — `/review` chains the audit so the verdict still lands at wrap-up. Don't conflate the agent that finds with the skill that fixes.

## Hard rules

1. **Prefer a rule to a signpost when it's checkable.** A signpost for something a check could catch is hope.
2. **Never restate an enforced rule in a signpost** — omit it entirely, no pointer.
3. **Test everything via `just test-rules`** — a rule or signpost with no passing self-test isn't done.
4. **architecture.md is terse + backlinked** — one line citing what enforces it; it records what's true *now*, not a manual.
5. **A stale backlink is drift** — a decision citing a rule/signpost that no longer exists must be fixed or removed.
