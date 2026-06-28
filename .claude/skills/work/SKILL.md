---
name: work
description: ALWAYS invoke when the user says "/work", "/work spec|plan|handover|complete|research", "spec this", "plan this out", "hand this over to a fresh chat", "what's in the backlog / what am I working on", "save this as research", "start work on …", or "wrap this into a plan" — the working-docs skill (specs · plans · handovers · research) over the `.work` journal.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(ls *), Bash(mkdir *), Bash(mv *), Bash(find *), Bash(git branch *), Task, AskUserQuestion
---

# Work

The working-docs skill. Five flows over a self-saving `.work/` repo: **spec** what to build · **plan** how · **handover** to a fresh chat · **complete** to close it out · **research** to capture a dig. Templates carry the structure; this skill carries the process. Dispatch on the first argument.

## Where everything lives

`.work/` is the working-docs journal — a local folder, gitignored, kept OUT of the code repo. If you make it its own git repo (or symlink to a standalone one), the `work-journal-commit` Stop hook auto-commits it every turn; until then it's just local files. Either way **this skill never commits** — saving is the hook's job (or a manual commit if you've made it a repo). Active work lives under `tasks/`, mirroring its git branch:

```
.work/tasks/<state>/<branch-path>/    state ∈ backlog · ready · complete
    spec.html · plan.html · wrap-up.html (from /review)
```

The branch-path carries the **type** + an optional **story/moment** grouping: branch `feat/blog/article-list` → `.work/tasks/<state>/feat/blog/article-list/`. Types: **`feat/`** (features — group related ones under a story/moment, e.g. `feat/blog/article-list`) and **`harness/`** (tooling · process · architecture). No-prefix branch → `tasks/<state>/adhoc/<name>/`.

Alongside `tasks/`, top-level: **`archive/`** (shipped/abandoned history), **`research/`** (briefs), **`handovers/`** (offload docs), **`tmp/`** (scratch, ignored).

- **backlog** — specced, not yet planned
- **ready** — planned (plan agreed), being / ready to be worked
- **complete** — finished (moved here by `work complete`)

**This skill never creates or touches git worktrees or branches** — you own those (and any per-feature env setup). It reads the current branch (`git branch --show-current`) to place/find the folder; locate existing work by its branch-path across `tasks/{backlog,ready,complete}/`.

## HTML, always — and visual

Every artefact is **HTML** — you read HTML for legibility, and depth you don't always need hides in collapsible `<details>`. Author from `templates/{spec,plan,handover,research}.html`: replace the FILL markers, delete unused blocks, keep the plain-English bar.

**Be multimodal.** Prose is the weakest explainer. Wherever a picture lands a concept faster — architecture, a data flow, a sequence, a comparison — reach for an **inline `<svg>` diagram, an image, or a table**, and caption it. This holds for spec, plan, and research alike.

## Modes

| Invocation | What happens |
|---|---|
| `/work` | List the `.work` tree — backlog / ready / complete at a glance. |
| `/work spec` | Draft a `spec.html` (feature or bug) into `backlog/`. |
| `/work plan` | Explore the code, write a phased `plan.html`; on approval move to `ready/`. |
| `/work handover` | Write a `handover.html` to offload to a fresh chat. |
| `/work complete` | Audit the plan for drift, summarise, move to `complete/`. |
| `/work research` | Capture a research dig as a dated brief. |

---

## Flow: `/work` (no args)

List the tree — e.g. `find .work/tasks/backlog .work/tasks/ready .work/tasks/complete -name spec.html` → the slugs grouped by state, one line each. A glance at what's where. Don't dump file contents. (This replaces the old `BACKLOG.md`.)

## Flow: `/work spec`

The spec is **user-level alignment** — what & why, in plain language, **no code** (code is the plan's job).

1. **Slug + intended branch-path.** Kebab-case, concrete (`popular-first-sort`, not `sorting`). Ask the branch-path it'll live under (e.g. `feat/course/chrome`) — no branch/worktree exists yet. Clash → a different slug.
2. **Create `.work/tasks/backlog/<path>/spec.html`** from `templates/spec.html` (`mkdir -p` the folder).
3. **Walk it interactively.** Fill what's clear from chat; ask what you can't infer. Sections: Overview · Problem (rename to **Symptom** for a bug — observed vs expected + when) · Solution · Constraints · Open questions · Verification · Decisions · Estimated files/edits. **No code blocks** — name the *areas* to look at, not the code. Tuck depth into `<details class="more">`.
4. **Close out Open questions** before exit — surface each, lock it down or defer. (The main drift vector; don't skip.)
5. **Output the link** to `spec.html`. Nothing else. Hold in chat memory: working on `<path>`.

## Flow: `/work plan`

Turns a spec into a concrete, code-aware, **phased** plan — **this is where architecture and code get tackled** (the deep planning the spec deliberately skipped). It runs the plan-mode *shape* itself; it does **not** enter native plan mode (that locks edits to its own file).

1. **Orient.** Read the work's `spec.html` (current branch's folder under `tasks/backlog/`; if unclear, ask). The branch/worktree already exists — you made it. Give a brief summary + the spec link.
2. **Explore the codebase (parallel `Explore` subagents).** Map the patterns, the files in play, and the **sibling to mirror**. The cross-file sweep is load-bearing: `ls src/lib/<closest-sibling>/` and mirror its shape — the canonical allowlist `domain`/`db`/`server`/`client`/`hooks`/`types`/`index` + a `.test.ts` per pure file, thin React/Astro shells (per `docs/arch/architecture.md` + the `lib` signpost). Skipping it is the single biggest source of drift.
3. **Resolve open questions** (`AskUserQuestion`) — the spec's, plus any code-level ones exploration surfaced.
4. **Write `.work/tasks/backlog/<path>/plan.html`** from `templates/plan.html`. Each phase has a **Build** cluster + a **Prove-it-works** cluster. Give EVERY tickbox an `evidence:` type now, at plan time, in one of two tiers: **evidence** (`diff`/`unit`/`db-query`/`e2e:cmd`) = a written note judged on its words; **artifact** (`screenshot`/`video`/`log`) = a file you save into an `evidence/` folder beside the plan and EMBED inline (`<img>`/`<video>`/`<pre>`) so it renders. Or `blocked:why`/`accepted:why`. A box that claims it *works / renders / persists / fires* may never be `diff`/`unit` — give it an artifact wherever a human would want to look. No trailing Verification section — proof is inline, per phase. NOT in a feature plan: release / staging-rehearsal / deploy (that's `/release`); pushing to a dev/staging environment during dev is fine.
5. **Present it; get approval.** Do **not** implement yet — the user reads `plan.html` and says go.
6. **On approval, move `backlog → ready`:** `mv .work/tasks/backlog/<path> .work/tasks/ready/<path>`.
7. Thereafter it's a **living, evidence-driven doc.** Tick a box only when its drawer holds the matching proof — a written note for evidence boxes, an embedded file (saved to `evidence/`) for artifact boxes; a green unit gate does NOT satisfy a `screenshot`/`log`/`db-query` box. Flip a phase to `verified` only once every Prove box is `done` or `blocked` — that fires a Claude check over EVERY done box in the phase (written notes + embedded artifacts), which stamps or bounces each. Until then it's `built·unverified`. `blocked`/`accepted` are honest; a fake tick is a lie.

## Flow: `/work handover`

1. **Write `.work/handovers/<date>-<topic>.html`** from `templates/handover.html` — stand-alone (the reader has none of this context): what the work is, where it stands, what's done, what to do next, pointers, gotchas. Link the spec/plan rather than restate them.
2. **Output the link** — you paste it into the fresh chat.

## Flow: `/work complete`

The closer. Normally run `/review` first (it lands `wrap-up.html` in the folder).

1. **Audit `plan.html` end-to-end for drift.** Walk every task and the Verification checklist; tick what's genuinely done/verified, and **surface anything still unticked** — that's the drift. Confirm the plan was actually completed.
2. **Write a short Outcome summary** into `plan.html` — what shipped, in a few lines.
3. **Move `ready → complete`:** `mv .work/tasks/ready/<path> .work/tasks/complete/<path>`.
4. Report the move (the Stop hook saves it).

## Flow: `/work research`

1. **Pick a topic slug** + today's date.
2. **Write the brief** from `templates/research.html` → `.work/research/<date>-<topic>.html` (or, if a piece of work is active, that folder's `research/`). Summary up top (3–5 load-bearing bullets), findings (lean on diagrams / images / comparison tables), then a **cited Sources list**.
3. **Output the link.**

---

## Hard rules

1. **HTML for everything** (spec · plan · handover · research). Author from the templates; don't reinvent the structure. Be multimodal — diagrams / images / tables over walls of prose.
2. **The spec is user-level — no code blocks.** Code and architecture are the plan's job.
3. **Never create or touch worktrees or branches** (or per-feature env setup) — you own those. Read the current branch to place the folder.
4. **Never commit `.work` by hand** — the Stop hook saves it. Never commit the main repo, push, or branch.
5. **Slug / path clash → a different slug**, never `-2`/`-3`.
6. **Link, don't paste** artefact contents into chat.
7. **Folders are state** — move the whole folder: `spec`→`backlog`, `plan`→`ready` (on approval), `complete`→`complete`.
8. **Templates win on *what* to capture; this skill wins on *how*.**
9. **Evidence before the tick.** Each box's `evidence:` type (set at plan time) is one of two tiers: **evidence** (`diff`/`unit`/`db-query`/`e2e` — a written note) or **artifact** (`screenshot`/`video`/`log` — a file saved to `evidence/` beside the plan and embedded so it renders inline). "Works" boxes get an artifact, never `diff`/`unit`. Flipping a phase to `verified` fires a Claude check over every done box. A fake tick is a lie.
