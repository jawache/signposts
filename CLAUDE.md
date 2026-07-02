# Signposts

Signposts is a **rules repository** — the canonical, forkable home for the *rules* that keep an
AI agent on the rails while building on a given stack. It's the idea Vercel turned into a
**skills** repository (`vercel-labs/agent-skills`), turned instead to **rules**. The unit of
value is a **bundle = all the rules for a capability or stack**: the `cloudflare` bundle is
"everything you need to build on Cloudflare without the agent screwing it up", `astro` the same
for Astro, and so on. It will live at `github.com/jawache/signposts`.

**In one line:** `scaffold` sets up the repo you're working on with your default toolchain *the
way you like it* — the `justfile`, `CLAUDE.md`, the `docs/` layout, the signposts engine, the npm
deps, the lefthook git-hook — and `propagate` pushes a new rule (or a fix to a bundle) **back up**
to this repo as a PR. That up-flow is the differentiator nobody else ships: **decentralised
authorship** — a rule is born in the project that hit the need, then bubbles up to be shared.

**Skills are the mechanism, not the product.** The `/signposts` skill (and the `coach` agent it
spawns) exists to *operate and author* the rules machinery — it is not what people contribute.
People contribute **rules**, grouped into bundles. The general workflow skills (`/work`,
`/review`) and the code-review agents are *not* part of Signposts — they live globally in the
personal **workbench** repo (`~/.claude`), a different job from steering the agent.

A **signpost** is anything that steers the agent: **enforced** (a `rules/` check that blocks at
edit + commit — "you can't do this"; the heart of it) or **advisory** (path-glob notes in
`signposts.yaml` — "mind the shape here"). "Signposts" replaces the old name "harness".

**Design brief (read first):** [`.work/tasks/feat/signposts/system-design/spec.html`](.work/tasks/feat/signposts/system-design/spec.html)
— the epic-level design. It is the prior for all work here until `docs/arch/architecture.md` exists.

## Status — design-first

We are at design stage. Only a **minimal dogfood setup** is installed so we can use
Signposts *on this repo as we build it*:

- `.claude/agents/` — `coach` (the reflect detector `/signposts reflect` spawns).
- `.claude/skills/` — `signposts` (author + share rules and signs; modes reflect · propagate · install).

The general workflow skills (`work`, `review`) and the code-review agents (`secops · codeops ·
docops · devops`) now live globally in **workbench** (`~/.claude/`), so they apply across every
project — split out because they're a different job from steering the agent.

**Not yet wired** (it's the planned build, not a regression): the enforcement engine —
`signposts.yaml`, `rules/` + `rules/README.md`, `lefthook.yml`, `justfile`, `sgconfig.yml`,
the `.claude/hooks/`, and the bundle layout. Skills/agents reference these; they describe
the target, and won't fully fire until the engine lands. `release` + `testimony` skills were
deliberately left out of the minimal set (deploy-coupled / not core).

## Work conventions — the NEW model

`.work/` here uses the **stable-folder** model from the spec's Part 1: work lives at
`tasks/<type>/<area>/<name>/` (**type ∈ feat · bug · chore**) with **status in a
`.props.yaml`** inside the folder — the path never moves. See [`.work/README.md`](.work/README.md).
The installed `/work` skill now describes this model (reconciled in Phase 1 of the
system-design plan); don't recreate `backlog/ready/complete` directories.

## Communication

Plain English, headline first, define jargon, give the why. British English. No
Claude/Anthropic attribution in commits, PRs, or issues.
