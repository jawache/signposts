---
name: signposts
description: ALWAYS invoke when the user says "/signposts", "/signposts reflect", "/signposts propagate", "/signposts install", "reflect on this session", "make this a rule", "add a rule / a sign / a signpost", "enforce this", "send this rule to my hub / upstream", "install signposts from <repo>", or wants to author / test / share a rule or a sign.
allowed-tools: Read, Write, Edit, Glob, Grep, Task, Bash(ls *), Bash(cp *), Bash(mkdir *), Bash(just *), Bash(npx signposts *), Bash(git status*), Bash(git add*), Bash(git commit*), Bash(git push*), Bash(git checkout*), Bash(gh pr*)
---

# Signposts — reflect · propagate · install

One skill, **three modes**. Each is the *judgement* half of a job whose *facts* come
from a deterministic script — so you never rediscover what a script can just tell you.

| Mode | What it does | Its fact-provider |
|---|---|---|
| **reflect** | read the session, propose new signs/rules, author + test them | `npx signposts facts` (+ the `coach` agent) |
| **propagate** | send a rule/sign to a repo you name (your hub, or upstream) | `git` / `gh` |
| **install** | cherry-pick signs/rules from another repo into this one | `npx signposts diff` |

**The rule between the two halves:** the script emits facts (what drifted, what's in
that repo, what collides); *you* apply the judgement (which to keep, how to genericise,
how to resolve a clash). Never recount a metric a script gave you; never hard-code a
decision a human should make.

Ground truth for the model (a **sign** steers, a **rule** blocks) and for *how* to write
each is `rules/README.md` and the `docs/`. Read them; don't restate them.

---

## Mode: `reflect` — the coach loop

Run at the **end of a session**. Surfaces where the machinery let drift slip through, and
turns each keeper into a sign or a rule.

1. **Gather facts.** `npx signposts facts` from the repo root — deterministic stats + a
   navigable drift index (hook fires/outcomes, justfile bypasses, sign-coverage gaps,
   course-corrections), each with a transcript line. `npx signposts facts --around <line>`
   opens any cited spot. (It reads the transcript, not a diff — runnable any time.)
2. **Spawn `coach`** (Task) with that report. It reads the cited lines and returns
   candidate **rules** + **signs** — each a place the machinery let the agent go wrong.
   Coach writes nothing.
3. **Dispose each candidate** via the authoring reference below — prefer a **rule** when
   it's mechanically checkable; a **sign** for shape/judgement a check can't make.
   Rejecting one is fine — say why.
4. **Test** — `just test-rules` green for anything you added.

The richest signal is the **course-corrections**: each is a spot a sign or rule would have
caught. Aim to leave with at least one of each when the session earned them.

---

## Mode: `propagate` — send a signpost to a repo you name

Lift a rule or sign out of *this* project and send it somewhere reusable — **your own hub
repo** (private is fine), or **upstream** as a PR. This up-flow is the differentiator:
guardrails born in real work bubble up to be shared.

1. **Pick** the entry (or a whole namespace) to send. Confirm the target repo with the
   user — a path/URL to their hub, or the upstream pack. **Never guess the destination.**
2. **Genericise.** Strip what was specific to this project — a hard-coded path, a repo
   name, a private detail — so it lands usable. This is judgement; do it deliberately.
3. **Choose the namespace** it belongs to in the target (e.g. `neon`, or the user's hub
   namespace). A pack *is* a namespace — its `signs:`/`rules:` groups plus the scripts in
   `rules/<namespace>/`.
4. **Apply.** Into the target repo: copy the script(s) into `rules/<namespace>/`, and merge
   the entry into the matching `signs:`/`rules:` group in its `signposts.yaml` (create the
   group if absent). Keep the `--test`.
5. **Ship** — for your hub, `git add/commit/push`; for upstream, open a PR (`gh pr create`)
   with a one-line why. **Sending is outward-facing — confirm before you push or open a PR.**

---

## Mode: `install` — cherry-pick from any repo

Point at any repo — your hub, a teammate's project, an official pack — and pull what you
want. Any repo with a `signposts.yaml` is installable; there's no separate pack format.

1. **Diff.** `npx signposts diff <source-repo>` (add `--json` to consume it) — reports, per
   namespace, for both signs and rules: **new** (take freely), **COLLIDE** (you both have
   the id, differing), **same** (already have), plus the script files each namespace ships.
   Facts, deterministically.
2. **Present the picker.** Walk the user through it: offer whole **namespaces** ("take all
   of `neon`") or individual **entries**. Show what each is.
3. **Resolve collisions in conversation** — this is exactly where judgement beats a rigid
   rule. For each COLLIDE, show both versions and ask: keep mine, take theirs, or merge.
   Don't silently clobber.
4. **Apply the picks.** Copy `rules/<namespace>/…` scripts in, and merge the chosen entries
   into your `signs:`/`rules:` groups. Add the source to `packs:` so `npx signposts refresh`
   tracks it.
5. **Test + arm.** `just test-rules` green; the new rules fire on next edit/commit.

---

## Authoring reference — a sign vs a rule

Full detail is `rules/README.md`; the shape at a glance:

| Want to… | Author | Where |
|---|---|---|
| **steer** an area (shape, judgement, a constraint no check can make) | a **sign** | a `signs:` entry (`id` + `globs` + `text`), grouped by namespace |
| **block** a mechanically-checkable mistake | a **rule** | a `rules:` entry naming a script via `use:` (core or your own), grouped by namespace |
| ban/require a **code shape** (TS/TSX) | a rule | drop a `rules/ast-grep/<name>.yml` — zero code |
| something **novel** | a rule | a small own-script `rules/<ns>/<name>.{mjs,sh}` with a `--test` |

- **A sign** is delivered when the agent touches its area; keep it short and specific.
  Overlapping signs *both* apply, in file order.
- **A rule** names the decision in its `message:`, ships a `--test` (a legal + an illegal
  sample), and defaults to `when: [edit, commit]` (omit unless a tool-gate → `[commit]`).
- **Prefer a rule whenever it's checkable** — a sign for something a check could catch is
  hope, not enforcement. And **never restate an enforced rule in a sign** — omit it, no
  pointer.

## Hard rules

1. **Facts from the script, judgement from you.** Run the fact-provider; reason over it.
2. **Prefer a rule to a sign when it's checkable.**
3. **Test everything via `just test-rules`** — an untested rule/sign isn't done.
4. **Confirm the destination + confirm before pushing** in `propagate`; **never clobber a
   collision** in `install`. Both are the user's call.
5. **Author in place.** Build rules where they're used; share by pointing others at your
   repo — never extract them into a separate package.
