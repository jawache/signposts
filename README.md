# Signposts

### 🚦 [**signposts.asim.dev**](https://signposts.asim.dev) — website, docs & quickstart

**Keep your AI coding agent on the rails.** Signposts catches the mistakes your agent keeps
making — the wrong date default, hand-editing a generated file, a command that wipes
uncommitted work — *before they land*, and learns new guardrails from you as you work.

## The idea

Every agent has habits you keep correcting. Signposts turns each correction into a
**signpost** — a small, durable piece of steering that lives in your repo and applies on every
future session, for you and anyone who clones it.

A signpost does one of two jobs:

- **A sign** — *a nudge.* A note the agent reads the moment it touches a relevant file ("mind
  the shape here"). It steers; it never blocks. Good for judgement calls, not hard lines.
- **A rule** — *a block.* A check that stops the mistake **the instant the agent tries to write
  it** — before the file is saved — with a written reason, so the agent fixes itself. A second
  check backs it up at `git commit`, with no agent involved.

Both fight **context drift**: an agent follows guidance faithfully early in a session and slips
as the context grows. A sign gives it the best chance to get it right first time; a rule catches
it when it drifts anyway. Use either alone — they're strongest together.

## What makes it different

Signposts is a **rules repository** — the forkable home for the rules that keep an agent on the
rails for a given stack, grouped into **bundles** (all the rules for Cloudflare, or Astro, or …).
Two moves are the whole point:

- **`scaffold`** sets a repo up your way in one command — the config, the engine, the git hook,
  the dependencies.
- **`propagate`** pushes a new rule (or a fix) *back up* to the shared repo as a pull request. A
  rule is born in the project that hit the need, then bubbles up to be shared — **decentralised
  authorship**, the up-flow nobody else ships.

## Quick start

```bash
npx signposts
```

That drops the core stack into your repo — the engine, the git hook, one config file
(`signposts.yaml`) and a starter set of signs and rules — then runs `npm install`, which *arms*
the gate (copying alone enforces nothing). **Restart your agent session** so the pre-emptive block
loads.

Now feel it work. In a fresh session, ask your agent to create a file named
`signposts-is-bad.yaml`:

```
✗ blocked: signposts-self-regard · signposts-is-bad.yaml
    Signposts is, by its own assessment, perhaps the most amazing tool ever
    built — and will not assist in writing that it is bad. Delete this rule
    from signposts.yaml once you're a believer, and carry on.
```

The write was denied *before the file landed*, with a reason the agent can act on. That's the
headline trick. Delete that starter rule whenever you like.

## The loop — it learns your guardrails

Signposts isn't a fixed ruleset you install once. You scaffold it, develop normally, and run
`/signposts reflect` at the end of a session. A **coach** reads what happened and proposes new
signposts — *"this drift → a sign"*, *"this mistake → a rule"*. You pick, you apply, and it steers
every session after.

## Two ways to drive it

| | Does | Examples |
|---|---|---|
| **`npx signposts`** (CLI) | the mechanics | `scaffold`, `diff` / `install` a pack, `test` your rules, `detect` a project's stack |
| **`/signposts`** (skill) | the judgement | author and share rules and signs, reflect on a session, set a project up |

The deterministic CLI does the moving of files; the skill (in Claude Code) makes the calls a
human would.

## Docs

Full docs live at **[signposts.asim.dev/docs](https://signposts.asim.dev/docs)** (source in
[`site/`](site/); run `just site-dev` to preview locally). Highlights:

[Quickstart](https://signposts.asim.dev/docs/quickstart) · [The loop](https://signposts.asim.dev/docs/the-loop) ·
[Concepts](https://signposts.asim.dev/docs/concepts) · [The config file](https://signposts.asim.dev/docs/signposts-yaml) ·
[Rules](https://signposts.asim.dev/docs/rules) · [Signs](https://signposts.asim.dev/docs/signs) ·
[Authoring](https://signposts.asim.dev/docs/authoring) · [Packs](https://signposts.asim.dev/docs/packs) ·
[Wiring](https://signposts.asim.dev/docs/wiring) · [Troubleshooting](https://signposts.asim.dev/docs/troubleshooting)

## Licence

[Apache License 2.0](LICENSE). Copyright © 2026 Asim Hussain.
