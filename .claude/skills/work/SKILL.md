---
name: work
description: ALWAYS invoke when the user says "/work", "/work spec|plan|handover|complete|research", "spec this", "plan this out", "hand this over to a fresh chat", "what's in the backlog / what am I working on", "save this as research", "start work on …", or "wrap this into a plan" — the working-docs skill (specs · plans · handovers · research) over the `.work` journal.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(ls *), Bash(mkdir *), Bash(mv *), Bash(find *), Bash(git branch *), Task, AskUserQuestion
---

# Work

The working-docs skill. Five flows over a self-saving `.work/` repo: **spec** what to build · **plan** how · **handover** to a fresh chat · **complete** to close it out · **research** to capture a dig. Templates carry the structure; this skill carries the process. Dispatch on the first argument.

## Where everything lives

`.work/` is the working-docs journal — a local folder, gitignored, kept OUT of the code repo. If you make it its own git repo (or symlink to a standalone one), the `work-journal-commit` Stop hook auto-commits it every turn; until then it's just local files. Either way **this skill never commits** — saving is the hook's job (or a manual commit if you've made it a repo). Active work lives under `tasks/`:

```
.work/tasks/<type>/<area>/<name>/      type ∈ feat · bug · chore
    .props.yaml          ← status + metadata; the folder NEVER moves
    spec.html · plan.html · wrap-up.html (from /review) · evidence/
```

**Stable folder, status in a file.** The path is `tasks/<type>/<area>/<name>/` and it *never moves* — status is a field in `.props.yaml`, not the directory. A link to a task stays valid for its whole life, and a UI can read the whole tree. The three coordinates:

- **type** — `feat` (a feature), `bug` (a defect), or `chore` (tooling · process · architecture · refactors).
- **area** — the epic or area of the codebase it belongs to (`signposts`, `blog`, `auth`), grouping related work.
- **name** — a concrete kebab-case slug (`popular-first-sort`, not `sorting`).

So: `feat/blog/article-list/`, `bug/auth/token-refresh/`, `chore/signposts/work-conventions/`.

Alongside `tasks/`, top-level: **`research/`** (briefs), **`handovers/`** (offload docs), **`tmp/`** (scratch, ignored).

**Decoupled from git.** This skill never creates or touches worktrees or branches — you own those (and any per-feature env setup). Unlike the old model it does **not** read the branch to place work: `type·area·name` locate a folder. Hold the active task's path in chat memory; `/work` (no args) lists the tree.

## The `.props.yaml` schema

Every task folder carries a `.props.yaml` — the record `/work` (and later a UI) reads:

```yaml
status: backlog        # backlog | ready | in-progress | done | cancelled
type: feat             # feat | bug | chore
area: signposts        # the epic / area of the codebase
name: system-design    # kebab-case slug (matches the folder)
title: "Signposts — system design"   # one human-readable line
tags: [scaffold, propagate]          # optional, for search / grouping
created: 2026-06-26    # ISO date, set once
updated: 2026-06-27    # ISO date, bumped on each status change
```

The status values, in order of life:

- **backlog** — specced, not yet planned.
- **ready** — planned (plan agreed), ready to be / being worked.
- **in-progress** — actively being built.
- **done** — finished (closed by `/work complete`).
- **cancelled** — abandoned; kept for the record, never deleted.

**A status change edits this file — it never moves the folder.** `created` is set once; bump `updated` whenever status changes.

## HTML, always — and visual

Every artefact is **HTML** — you read HTML for legibility, and depth you don't always need hides in collapsible `<details>`. Author from `templates/{spec,plan,handover,research}.html`: replace the FILL markers, delete unused blocks, keep the plain-English bar.

**Be multimodal.** Prose is the weakest explainer. Wherever a picture lands a concept faster — architecture, a data flow, a sequence, a comparison — reach for an **inline `<svg>` diagram, an image, or a table**, and caption it. This holds for spec, plan, and research alike.

## Modes

| Invocation | What happens |
|---|---|
| `/work` | List the `.work` tree — every task with its status, at a glance. |
| `/work spec` | Draft a `spec.html` (feature or bug); create the folder + `.props.yaml` at `status: backlog`. |
| `/work plan` | Explore the code, write a phased `plan.html`; on approval set `status: ready`. |
| `/work handover` | Write a `handover.html` to offload to a fresh chat. |
| `/work complete` | Audit the plan for drift, summarise, set `status: done`. |
| `/work research` | Capture a research dig as a dated brief. |

---

## Flow: `/work` (no args)

List the tree — `find .work/tasks -name .props.yaml`, read each one's `status` + `title`, and print one line per task grouped by status (or by area). A glance at what's where. Don't dump file contents. (This replaces the old `BACKLOG.md`.)

## Flow: `/work spec`

The spec is **user-level alignment** — what & why, in plain language, **no code** (code is the plan's job).

1. **Type · area · name.** Pick the **type** (feat·bug·chore), the **area** (the epic it belongs under, e.g. `signposts`), and a concrete kebab-case **name** (`popular-first-sort`, not `sorting`). Clash with an existing folder → a different name, never `-2`/`-3`.
2. **Create the folder** `.work/tasks/<type>/<area>/<name>/` (`mkdir -p`) with `spec.html` from `templates/spec.html` **and** a `.props.yaml` at `status: backlog` — fill `type·area·name·title`, set `created`/`updated` to today.
3. **Walk it interactively.** Fill what's clear from chat; ask what you can't infer. Sections: Overview · Problem (rename to **Symptom** for a bug — observed vs expected + when) · Solution · Constraints · Open questions · Verification · Decisions · Estimated files/edits. **No code blocks** — name the *areas* to look at, not the code. Tuck depth into `<details class="more">`.
4. **Close out Open questions** before exit — surface each, lock it down or defer. (The main drift vector; don't skip.)
5. **Output the link** to `spec.html`. Nothing else. Hold in chat memory: working on `<type>/<area>/<name>`.

## Flow: `/work plan`

Turns a spec into a concrete, code-aware, **phased** plan — **this is where architecture and code get tackled** (the deep planning the spec deliberately skipped). It runs the plan-mode *shape* itself; it does **not** enter native plan mode (that locks edits to its own file).

1. **Orient.** Read the work's `spec.html` (the `<type>/<area>/<name>/` folder you hold in chat memory; if unclear, list the tree and ask). Give a brief summary + the spec link.
2. **Explore the codebase (parallel `Explore` subagents).** Map the patterns, the files in play, and the **sibling to mirror**. The cross-file sweep is load-bearing: `ls src/lib/<closest-sibling>/` and mirror its shape — the canonical allowlist `domain`/`db`/`server`/`client`/`hooks`/`types`/`index` + a `.test.ts` per pure file, thin React/Astro shells (per `docs/arch/architecture.md` + the `lib` signpost). Skipping it is the single biggest source of drift.
3. **Resolve open questions** (`AskUserQuestion`) — the spec's, plus any code-level ones exploration surfaced.
4. **Write `plan.html` into the work's own folder** (`.work/tasks/<type>/<area>/<name>/`, beside its `spec.html`) from `templates/plan.html`. Each phase has a **Build** cluster + a **Prove-it-works** cluster. Give EVERY tickbox an `evidence:` type now, at plan time, in one of two tiers: **evidence** (`diff`/`unit`/`db-query`/`e2e:cmd`) = a written note judged on its words; **artifact** (`screenshot`/`video`/`log`) = a file you save into an `evidence/` folder beside the plan and EMBED inline (`<img>`/`<video>`/`<pre>`) so it renders. Or `blocked:why`/`accepted:why`. A box that claims it *works / renders / persists / fires* may never be `diff`/`unit` — give it an artifact wherever a human would want to look. No trailing Verification section — proof is inline, per phase. NOT in a feature plan: release / staging-rehearsal / deploy (that's `/release`); pushing to a dev/staging environment during dev is fine.
5. **Present it; get approval.** Do **not** implement yet — the user reads `plan.html` and says go.
6. **On approval, set `status: ready`** in `.props.yaml` (edit the field, bump `updated`). The folder does **not** move.
7. Thereafter it's a **living, evidence-driven doc.** Tick a box only when its drawer holds the matching proof — a written note for evidence boxes, an embedded file (saved to `evidence/`) for artifact boxes; a green unit gate does NOT satisfy a `screenshot`/`log`/`db-query` box. Flip a phase to `verified` only once every Prove box is `done` or `blocked` — that fires a Claude check over EVERY done box in the phase (written notes + embedded artifacts), which stamps or bounces each. Until then it's `built·unverified`. `blocked`/`accepted` are honest; a fake tick is a lie.

## Flow: `/work handover`

1. **Write `.work/handovers/<date>-<topic>.html`** from `templates/handover.html` — stand-alone (the reader has none of this context): what the work is, where it stands, what's done, what to do next, pointers, gotchas. Link the spec/plan rather than restate them.
2. **Output the link** — you paste it into the fresh chat.

## Flow: `/work complete`

The closer. Normally run `/review` first (it lands `wrap-up.html` in the folder).

1. **Audit `plan.html` end-to-end for drift.** Walk every phase's **Build** + **Prove-it-works** boxes; confirm each `done` box's drawer holds its matching evidence, and **surface anything still unticked, `missing`, or `blocked`** — that's the drift. Confirm the plan was actually completed.
2. **Write a short Outcome summary** into `plan.html` — what shipped, in a few lines.
3. **Set `status: done`** in `.props.yaml` (bump `updated`). The folder does **not** move.
4. Report the close-out (the Stop hook saves it).

## Flow: `/work research`

1. **Pick a topic slug** + today's date.
2. **Write the brief** from `templates/research.html` → `.work/research/<date>-<topic>.html` (or, if a piece of work is active, that folder's `research/`). Summary up top (3–5 load-bearing bullets), findings (lean on diagrams / images / comparison tables), then a **cited Sources list**.
3. **Output the link.**

---

## Hard rules

1. **HTML for everything** (spec · plan · handover · research). Author from the templates; don't reinvent the structure. Be multimodal — diagrams / images / tables over walls of prose.
2. **The spec is user-level — no code blocks.** Code and architecture are the plan's job.
3. **Never create or touch worktrees or branches** (or per-feature env setup) — you own those. `type·area·name` place the folder, not the branch.
4. **Never commit `.work` by hand** — the Stop hook saves it. Never commit the main repo, push, or branch.
5. **Slug / path clash → a different slug**, never `-2`/`-3`.
6. **Link, don't paste** artefact contents into chat.
7. **Status is a field, not a folder** — a status change edits `.props.yaml` (`backlog`→`ready` on approval, `ready`→`in-progress`→`done`); the folder NEVER moves.
8. **Templates win on *what* to capture; this skill wins on *how*.**
9. **Evidence before the tick.** Each box's `evidence:` type (set at plan time) is one of two tiers: **evidence** (`diff`/`unit`/`db-query`/`e2e` — a written note) or **artifact** (`screenshot`/`video`/`log` — a file saved to `evidence/` beside the plan and embedded so it renders inline). "Works" boxes get an artifact, never `diff`/`unit`. Flipping a phase to `verified` fires a Claude check over every done box. A fake tick is a lie.
