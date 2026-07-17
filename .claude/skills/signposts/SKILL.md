---
name: signposts
description: ALWAYS invoke when the user says "/signposts", "/signposts setup", "/signposts reflect", "/signposts propagate", "/signposts install", "set up signposts", "onboard this repo", "reflect on this session", "make this a rule", "add a rule / a sign / a signpost", "enforce this", "send this rule to my hub / upstream", "install signposts from <repo>", or wants to author / test / share a rule or a sign.
allowed-tools: Read, Write, Edit, Glob, Grep, Task, Bash(ls *), Bash(cp *), Bash(mkdir *), Bash(just *), Bash(npx signposts *), Bash(git status*), Bash(git add*), Bash(git commit*), Bash(git push*), Bash(git checkout*), Bash(gh pr*)
---

# Signposts — setup · reflect · propagate · install · refresh

One skill, several modes. Each is the *judgement* half of a job whose *facts* come
from a deterministic script — so you never rediscover what a script can just tell you.
The unit people adopt and share is the **bundle**: one contiguous block under `bundles:`
(its signs, rules, `settings`, and a `from:` pin when vendored) plus its `rules/<bundle>/`.

| Mode | What it does | Its fact-provider |
|---|---|---|
| **setup** | onboard a repo: author its **session sign** (the CLAUDE.md replacement), install the right grammars, adopt bundles from the pack + the user's hub | `npx signposts detect` / `diff` / `languages` |
| **reflect** | read the session, propose new signs/rules, author + test them | `npx signposts facts` (+ `--html` report card; + the `coach` agent) |
| **install** | cherry-pick a bundle from another repo (git/**local folder**) into this one | `npx signposts diff` |
| **refresh** | pull upstream fixes for a vendored bundle, keeping your local edits (semantic three-way) | the bundle's `from:` pin |
| **propagate** | send a rule/sign to a repo you name (your hub, or upstream) | `git` / `gh` |
| **uninstall** | remove a bundle: its block, its `rules/<bundle>/`, only the permissions nothing else needs | the `from:` pin + settings ledger |

The lifecycle modes (install · refresh · propagate · uninstall) are **agent-driven**: you read
the bundle block and orchestrate; deterministic primitives (source resolution, comment-preserving
`editYaml`, the three-way merge) do the mechanical parts. Reach for **`npx signposts scan`**
(audit the whole tree — reports, never blocks) in any mode.

**The rule between the two halves:** the script emits facts (what drifted, what's in
that repo, what collides); *you* apply the judgement (which to keep, how to genericise,
how to resolve a clash). Never recount a metric a script gave you; never hard-code a
decision a human should make.

Ground truth for the model (a **sign** steers, a **rule** blocks) and for *how* to write
each is the site docs — `site/src/content/docs/` locally, signposts.asim.dev/docs published.
Read them; don't restate them. The mental model in one line: a session sign is the **map**,
a touch sign is a **street sign**, a rule is a **barrier** (`docs/agent/map-sign-barrier.md`).

---

## Mode: `setup` — author the project's session sign, then enforce it

Run **when onboarding a repo onto Signposts** — or when its stack changes, or to bring an
old install up to date (every step is re-runnable). `npx signposts` (the scaffold) writes
files; **setup's product is the project's orientation** — a session sign that replaces the
fat CLAUDE.md. Sort everything the project knows into map / street sign / barrier, then
prove the leftover CLAUDE.md can shrink to a stub.

1. **Scaffold if needed — purging any old install first.** No `signposts.yml` yet? Run
   `npx signposts` — the deterministic scaffold (justfile, the commit-gate hook, the Claude
   hooks, the quick-start tour). Restart the session so the pre-emptive hook loads.
   **Scaffolded by an older version?** Old scaffolds wired the commit gate through
   **lefthook**; today's gate is `.githooks/pre-commit` + `git config core.hooksPath
   .githooks`, and stale machinery double-fires — or fires the OLD gate. Sweep for residue
   and remove it (on consent):
   - `lefthook.yml` / `.lefthook/`, and the `lefthook` devDependency (`npm uninstall lefthook`);
   - lefthook-written hook scripts in `.git/hooks/` (`grep -l lefthook .git/hooks/*`) — delete them;
   - `git config core.hooksPath` unset or wrong → point it at `.githooks`;
   - a section-first `signposts.yaml` → offer the bundle-first `signposts.yml` migration;
   - a pinned old `signposts` devDependency → let the scaffold re-run upgrade it.
   Then re-run `npx signposts` (it merges, never clobbers) and **diff the kept files**
   (justfile, `.githooks/`, `.claude/settings.json` hooks) against the current templates and
   offer the updates; a stale gate is a silent one.
2. **Ingest what exists.** Read CLAUDE.md / AGENTS.md / README / `docs/` — this is the raw
   material, not the output. Every paragraph of it gets disposed of in step 6.
3. **Census the codebase.** `npx signposts detect` (`--json`) — a file census + stack signals,
   with each language marked **native** (free — html/css/js/ts/tsx) or **needs-grammar**. Then
   spawn Explore sub-agents for what files actually say: layout (where logic lives vs where the
   docs claim it lives), naming conventions, test topology (what has tests, what e2e proves).
4. **Consult the user's hub.** If the user has a hub repo (their global CLAUDE.md declares it;
   otherwise ask once), `npx signposts diff <hub>` for its bundles — including any
   `profile-*` bundles: **worked examples** of a real project's session sign, one per
   archetype, with the usual companion bundles named in the summary. Read the example that
   matches the detected stack and **derive your questions from it** — everything the example
   states that you can't yet establish for *this* project is a question for the census or the
   user. Imitate the shape, never the words. On a blank repo the example is the plan. Also
   diff **source #1**, the installed pack itself: `npx signposts diff node_modules/signposts`.
   Don't hand-write what either already carries.
5. **Get each grammar in (on consent).** For each non-native language worth guarding
   (*on Neon → SQL is worth a grammar before a `.sql` file even exists*) — **you're an agent,
   so do whatever it takes**:
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
6. **Present the decomposition plan.** A table, line by line through everything step 2 found:
   *this paragraph → the session sign · this one → a touch sign on `site/**` · this one is
   mechanically checkable → a rule · this command → a justfile recipe · this one is stale →
   delete.* Get the user's yes before writing anything.
7. **Interview where the evidence is thin.** Ask the questions the profile example surfaced,
   plus anything the census contradicted — how they like to work, what the folder structure
   means, what e2e is for, what must never happen. **Grill; never invent an answer the user
   should give.** On a blank repo, steps 2–3 are empty and the interview is the whole show.
8. **Write + enforce.** Write the session sign (shape below, in the example's image) into the
   project's own bundle; install the chosen bundles (that's `install` mode); wire the rules
   that enforce what the sign claims. Teach **check-before-you-script**: core script → pack →
   hub, and an own-script only when none fits. Most "novel" rules aren't.
9. **The CLAUDE.md finale.** Offer to cut CLAUDE.md / AGENTS.md to a stub — show the
   recommended shape (a pointer to Signposts plus only what no signpost can carry) — or to
   delete it outright. **If a fat CLAUDE.md survives setup, the decomposition failed.**

**Prove it:** `npx signposts test` green, a bad edit blocked at the gate, then restart and
read the orientation as the agent will see it. Then `reflect` authors what each session earns.

### The session-sign shape (the map)

```yaml
- type: sign
  id: dev-orientation
  at: [session]
  text: |-
    <IDENTITY — one or two lines: what this project is, for whom.>
    Layout: <the folder map as pointers with globs — where each kind of thing lives,
    its test obligation, what must stay logic-free. The highest-value section.>
    Shape: <how work proceeds here — the constraints no glob can carry. This section
    shrinks over time as rules take over enforcing it.>
    <POINTERS — where deeper truth lives (docs/, the architecture doc); point, never restate.>
```

Anything area-specific belongs in a **touch sign** behind an `on:` glob; anything checkable
belongs in a **rule**; never restate either in the session sign.

---

## Mode: `reflect` — the coach loop

Run at the **end of a session**. Leaves a report a human can judge — *did the guardrails
engage with my work, and did they catch anything* — and turns each keeper into a sign or rule.

1. **Gather + surface the report.** `npx signposts facts` from the repo root, then
   `npx signposts facts --html`. Facts gives **hard numbers from the engine's event log** —
   per-rule **matched** (a touched file fell in the rule's scope — the metric that says the
   rule engaged, not `evaluated`) vs **blocked** / **overridden**, each rule and sign shown
   with its verbatim scope/message/text, never-fired rules, any rule-weakening flags — plus a
   navigable drift index from the transcript (justfile bypasses, signpost gaps,
   course-corrections), each with a transcript line. **Relay the markdown report into the
   conversation** — standalone reflect assumes no `.work` and no review skill, so the chat is
   where the person who ran it reads the result — and **cite the HTML card path** it wrote to
   `.signposts/reports/` as the durable, shareable artefact. `--around <line>` opens any cited
   spot. (Numbers deterministic; narrative heuristic — labelled.)
2. **Spawn `coach`** (Task) with the full facts output. It reads the cited lines and returns
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
3. **Choose the bundle** it belongs to in the target (e.g. `fcis`, or the user's hub bundle).
   A bundle *is* the unit — one top-level block (a `title`, a `summary`, its `signposts:` list,
   and optional `settings`) plus the scripts in `rules/<bundle>/`.
4. **Apply.** Into the target repo: copy the script(s) into `rules/<bundle>/`, and merge the
   entry into that bundle's `signposts:` list in its `signposts.yml` via `editYaml`
   (create the bundle block if absent, comments preserved). Keep the `--test`.
5. **Ship** — for your hub, `git add/commit/push`; for upstream, open a PR (`gh pr create`)
   with a one-line why. **Sending is outward-facing — confirm before you push or open a PR.**

---

## Mode: `install` — cherry-pick a bundle from any repo

Point at any repo — your hub, a teammate's project, an official pack — **or a local folder on
disk** (`../my-hub`, the common private-repo case) — and pull the **bundle** you want. In the
bundle-first schema a bundle is **one contiguous block** under `bundles:` (its signs, rules,
`settings`, and — for a vendored bundle — a `from:` provenance pin) plus its `rules/<bundle>/`
folder. Copying a bundle is copying that block plus that folder — nothing scattered. This is
**agent-driven**: you read the block and orchestrate the copy; the deterministic primitives
(source resolution, comment-preserving `editYaml`) do the mechanical parts.

1. **Diff.** `npx signposts diff <source-repo>` (add `--json`) — reports, per bundle, for signs
   and rules: **new** (take freely), **COLLIDE** (you both have the id, differing), **same**,
   plus the script files each bundle ships. Facts, deterministically — bundle-first and
   section-first sources both read correctly.
2. **Present the picker.** Offer whole **bundles** ("take all of `fcis`") or individual
   **entries**. Show what each is and, for a vendored bundle, where it came from.
3. **Resolve collisions in conversation** — judgement beats a rigid rule. For each COLLIDE, show
   both versions and ask: keep mine, take theirs, or merge. Never silently clobber.
4. **Apply the bundle.** Copy the source bundle's block into this repo's config as a top-level
   bundle key (via `editYaml`, comments preserved) and its `rules/<bundle>/**` folder across; merge any
   host-permissions the bundle's `settings` carries into `.claude/settings.json` (deny-only is
   auto-applied — an `allow` widens autonomy, so surface it for the user to add by hand);
   aggregate any rule-level `needs:` deps; write a `from:` pin recording the source + version.
   *(For one release the deterministic `npx signposts install <src> <ns>` still performs this
   apply — it prints a pointer here first.)*
5. **Test + arm.** `just test-rules` green; the new rules fire on next edit/commit.

## Mode: `refresh` — pull upstream fixes, keep your local edits

A vendored bundle is **editable in place** — editing it *is* your local override, and the `from:`
pin makes drift visible. Refresh is a **semantic three-way**, not a blind overwrite.

1. **Fetch the pin.** Resolve the bundle's `from:` source at its recorded (or a newer) version.
2. **Three-way per entry.** For each sign/rule, compare *base* (the pin) → *yours* → *upstream*:
   an upstream fix to something you never touched merges cleanly; a line you deliberately changed
   (a downgraded severity, a tuned glob) is **kept and flagged**; a genuine divergence surfaces
   for a call. Scripts merge the same way; a conflicting script lands a `.upstream` sidecar, never
   markers in the live file.
3. **Offer the up-flow.** A local improvement worth sharing → hand it to `propagate`.
   *(The deterministic `npx signposts refresh` still runs this three-way for one release.)*

---

## Authoring reference — a sign vs a rule

Full detail is in the site docs — `site/src/content/docs/` (see `authoring`); the shape at a glance:

| Want to… | Author | Where |
|---|---|---|
| **steer** an area (shape, judgement, a constraint no check can make) | a **sign** | a signpost with `type: sign` (`id` + `on` + `text`) in its bundle's `signposts:` list; `at: [session]` for orientation |
| **block** a mechanically-checkable mistake | a **rule** | a signpost with `type: rule` naming a script via `use:` (core or your own) in its bundle's `signposts:` list |
| ban/require a **code shape** (TS/TSX) | a rule | drop a `rules/ast-grep/<name>.yml` — zero code |
| something **novel** | a rule | a small own-script `rules/<ns>/<name>.{mjs,sh}` with a `--test` |

- **A sign** is delivered when the agent touches its area; keep it short and specific.
  Overlapping signs *both* apply, in file order.
- **A rule** names the decision in its `message:`, ships a `--test` (a legal + an illegal
  sample), and speaks the **moment vocabulary** `at: write | commit | delete | turn` (default
  `[write, commit]`; a whole-project tool-gate → `[commit]`; an end-of-turn check → `[turn]`).
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
