# Signposts

A **rules repository** — the forkable home for the *rules* that keep an AI agent on the rails
while it builds on a given stack. The unit of value is a **bundle**: all the rules for one
capability or stack (a `cloudflare` bundle, an `astro` bundle, and so on).

Two things make it different from a skills repository:

- **`scaffold`** sets a repo up your way in one command — the justfile, the signposts engine,
  the npm deps, the git pre-commit hook.
- **`propagate`** pushes a rule (or a fix) *back up* to this repo as a PR. A rule is born in the
  project that hit the need, then bubbles up to be shared — decentralised authorship, the up-flow
  nobody else ships.

A **signpost** steers the agent one of two ways: **enforced** (a `rules/` check that blocks at
edit and commit — "you can't do this") or **advisory** (a path-glob note in `signposts.yaml` —
"mind the shape here").

The `/signposts` skill (and the `coach` agent it spawns) operate the machinery — they aren't the
product. People contribute **rules**, grouped into bundles.

## Communication

Plain English, headline first. Be brief. Define jargon. British English. No Claude/Anthropic
attribution in commits, PRs, or issues.
