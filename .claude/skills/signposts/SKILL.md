---
name: signposts
description: ALWAYS invoke when the user says "/signposts", "/signposts setup", "/signposts reflect", "/signposts propagate", "/signposts install", "set up signposts", "onboard this repo", "reflect on this session", "make this a rule", "add a rule / a sign / a signpost", "enforce this", "send this rule to my hub / upstream", "install signposts from <repo>", or wants to author / test / share a rule or a sign.
allowed-tools: Read, Write, Edit, Glob, Grep, Task, Bash(ls *), Bash(cp *), Bash(mkdir *), Bash(just *), Bash(npx signposts *), Bash(git status*), Bash(git add*), Bash(git commit*), Bash(git push*), Bash(git checkout*), Bash(gh pr*)
---

# Signposts — setup · reflect · propagate · install

One skill, **four modes**. Each is the *judgement* half of a job whose *facts* come
from a deterministic script — so you never rediscover what a script can just tell you.

| Mode | What it does | Its fact-provider |
|---|---|---|
| **setup** | onboard a repo: install the right grammars, surface the pack's own rules, teach check-before-you-script | `npx signposts detect` / `diff` / `languages` |
| **reflect** | read the session, propose new signs/rules, author + test them | `npx signposts facts` (+ `--html` report card; + the `coach` agent) |
| **propagate** | send a rule/sign to a repo you name (your hub, or upstream) | `git` / `gh` |
| **install** | cherry-pick signs/rules from another repo (git/npm/**local folder**) into this one | `npx signposts diff` |

Two more deterministic helpers you can reach for in any mode: **`npx signposts scan`** (audit
the whole tree against the rules — reports, never blocks: see what an existing repo already
violates, or how many hits a rule you're about to add would have) and **`npx signposts
uninstall --pack <ns>`** (reverse one installed pack).

**The rule between the two halves:** the script emits facts (what drifted, what's in
that repo, what collides); *you* apply the judgement (which to keep, how to genericise,
how to resolve a clash). Never recount a metric a script gave you; never hard-code a
decision a human should make.

Ground truth for the model (a **sign** steers, a **rule** blocks) and for *how* to write
each is `rules/README.md` and the `docs/`. Read them; don't restate them.

---

## Mode: `setup` — get a project (and the agent) ready

Run **once, when onboarding a repo onto Signposts** — or when its stack changes. `npx signposts`
(the scaffold) writes files; **setup makes the project *and you* ready**: the right grammars, the
pack's own rules surfaced, the check-before-you-script habit. Every onboarding failure Signposts
was built to stop happened in the gap where setup should have been.

1. **Scaffold if needed.** No `signposts.yaml` yet? Run `npx signposts` — the deterministic
   scaffold (justfile, lefthook, the hooks, the quick-start tour). Restart the session so the
   pre-emptive hook loads. (Already set up → skip to detect.)
2. **Detect the stack.** `npx signposts detect` (`--json` to consume it) — a file census +
   `package.json` stack signals. It marks each language **native** (free — html/css/js/ts/tsx) or
   **needs-grammar**, and recommends the non-native ones (*on Neon → SQL is worth a grammar before
   a `.sql` file even exists*).
3. **Show the plan; get each grammar in (on consent).** Summarise it ("mostly TS, some Astro, on
   Neon → needs `astro` + `sql`"). For each non-native grammar, on the user's go — **you're an
   agent, so do whatever it takes**:
   - **Prebuilt first:** `npx signposts languages add <lang>` — installs `@ast-grep/lang-<lang>`
     (published for sql · python · go · rust · …). If it succeeds, done.
   - **No published package?** (astro · vue · svelte have none) — **build the grammar yourself**:
     `npm install -g tree-sitter-cli`; clone/fetch the `tree-sitter-<lang>` grammar (e.g.
     `tree-sitter-astro`); `tree-sitter build --output grammars/<lang>.so`; then
     `npx signposts languages register <lang> --library-path grammars/<lang>.so --ext <lang>`.
     That writes it into `sgconfig.yml customLanguages`, which the engine reads and registers.
   Don't dead-end at "no package" and don't hand-write a wrapper script — the grammar is the
   thing; get it built and registered. **Never make a grammar a base dep.** Language rules are
   then plain `rules/<ns>/ast-grep/*.yml` with `language: <lang>`; a misplaced ast-grep yml is
   caught by `signposts test`.
4. **Surface the pack's own rules.** `npx signposts diff node_modules/signposts` — **source #1**:
   the installed package *is* a diffable pack. Walk what it ships; offer to adopt what fits (that's
   `install` mode). Don't hand-write what the pack already carries.
5. **Teach check-before-you-script.** Leave the habit behind: before writing a script, ask — can
   `on`/`ignore` + a **core script** express this? does the **pack already ship it**
   (`signposts diff node_modules/signposts`)? Most "novel" rules aren't.

**Prove it:** `npx signposts test` green (the seeded rule's `.test.yml` + ast-grep validation runs
from `node_modules`), and a bad edit is blocked at the gate. Then `reflect` authors what the
session earns.

---

## Mode: `reflect` — the coach loop

Run at the **end of a session**. Surfaces where the machinery let drift slip through, and
turns each keeper into a sign or a rule.

1. **Gather facts.** `npx signposts facts` from the repo root — **hard numbers from the
   engine's event log** (per-rule catches@edit vs leaks@commit, never-fired rules, signs
   injected, any rule-weakening flags) plus a navigable drift index from the transcript
   (justfile bypasses, sign-coverage gaps, course-corrections), each with a transcript line.
   `--around <line>` opens any cited spot; `--html` writes a shareable report card to
   `.signposts/reports/`. (Numbers are deterministic; narrative is heuristic — labelled.)
2. **Spawn `coach`** (Task) with that report. It reads the cited lines and returns
   candidate **rules** + **signs** — each a place the machinery let the agent go wrong.
   Coach writes nothing.
3. **Dispose each candidate** via the authoring reference below — prefer a **rule** when
   it's mechanically checkable; a **sign** for shape/judgement a check can't make.
   Rejecting one is fine — say why.
4. **Test + size.** `just test-rules` green for anything you added; for a new rule, `npx
   signposts scan` shows how many pre-existing hits it already has (200 needs a different
   rollout than 3).

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

Point at any repo — your hub, a teammate's project, an official pack — **or a local folder on
disk** (`../my-hub`, the common private-repo case) — and pull what you want. Any repo with a
current-shape `signposts.yaml` is installable; there's no separate pack format. (An older-layout
repo is refused with a pointer to cherry-pick by hand.) Reverse one later with
`npx signposts uninstall --pack <ns>` — it removes the namespace's entries, scripts, and any
permissions it added, and nothing else.

1. **Diff.** `npx signposts diff <source-repo>` (add `--json` to consume it) — reports, per
   namespace, for both signs and rules: **new** (take freely), **COLLIDE** (you both have
   the id, differing), **same** (already have), plus the script files each namespace ships.
   Facts, deterministically.
2. **Present the picker.** Walk the user through it: offer whole **namespaces** ("take all
   of `neon`") or individual **entries**. Show what each is.
3. **Resolve collisions in conversation** — this is exactly where judgement beats a rigid
   rule. For each COLLIDE, show both versions and ask: keep mine, take theirs, or merge.
   Don't silently clobber.
4. **Apply the picks.** `npx signposts install <src> <ns>` does the deterministic apply: copies
   `rules/<namespace>/…`, merges the entries into your `signs:`/`rules:` groups (comments
   preserved), merges any host-permissions the pack carries into `.claude/settings.json`, and
   records what it owns in `packs:` so `refresh` (three-way merge) and `uninstall --pack` can
   track it.
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
- **Check before you script.** Before writing an own-script, ask: can `on`/`ignore` + a
  **core script** already express this? does the **pack already ship it**? Diff the
  installed pack first — `signposts diff node_modules/signposts` — and reach for a script
  only when neither can. (The highest-leverage habit: most "novel" rules aren't.)

## Hard rules

1. **Facts from the script, judgement from you.** Run the fact-provider; reason over it.
2. **Prefer a rule to a sign when it's checkable.**
3. **Test everything via `just test-rules`** — an untested rule/sign isn't done.
4. **Confirm the destination + confirm before pushing** in `propagate`; **never clobber a
   collision** in `install`. Both are the user's call.
5. **Author in place.** Build rules where they're used; share by pointing others at your
   repo — never extract them into a separate package.
