# rules/ — the project's runnable rules

The enforceable half of the project's conventions. Each rule that used to be prose
("never do X") is a check that fires when you do X, with a verbose error that names
the violation, explains why, and shows the fix. The check is the source of truth.

This is the **core** set — the rules that govern any repo (no stack assumptions).
Stack-specific rules (the `src/lib` architecture, `.env` encryption, Astro templates,
…) ship in their own **bundles** and are dropped in by `npx signposts` when you opt
into that stack — they are not here.

## Prove they work

Every rule has legal/illegal **samples** — they're the test, the documentation, and
the spec. One command proves the lot:

```
just test-rules    # ast-grep tests + the engine self-test (8 categories) + each check's --test
```

## How it runs — one engine, two triggers

`rules/_engine.mjs` is the evaluator. A rule's `when:` decides which triggers it fires on,
so **one config line drives both paths**:

- **edit** — the `preemptive-block.mjs` PreToolUse hook reconstructs the would-be file
  *in memory* and asks the engine (`phase: edit`). A violation is returned as a `deny`
  **before the write lands**, fed back so Claude self-corrects.
- **commit / push** — `lefthook.yml`'s `engine` job runs the same engine
  (`--phase commit`) over the staged set. Runs **without Claude** (a plain `git commit`),
  which is why the rule files live committed in the repo, not in a per-user cache.

Two safety checks stay **dedicated PreToolUse Bash hooks** (not engine rules) because they
must fire before a *command* runs and need runtime/git state: `check-git-discard` (an
irreversible working-tree wipe) and `strip-claude-attribution`. Edit-time *guidance*
(non-blocking) is separate again: the `signposts.mjs` PostToolUse hook injects per-area
notes from `signposts.yaml`.

## The eight categories (primitives)

Every rule is an instance of a **primitive** (`rules/primitives.mjs`), one per category.
`use:` names the primitive; the rest of the instance is its config.

| Cat | Primitive (`use:`) | Kind | Catches |
|---|---|---|---|
| **A** | `ast-grep-pattern` | content | a TS/TSX AST pattern (declarative `rules/ast-grep/*.yml`, **auto-discovered**) |
| **B** | `symbols-in-sibling` | content | correlation across nodes/files via the parser-as-library (e.g. exported symbols unreferenced in the sibling test) |
| **C** | `sibling-exists` | path | a required sibling file is missing (no content parse) |
| **D** | `json-invariant` (+ own-script) | content | a structured-file invariant (e.g. `package.json` `scripts` must be empty; a justfile recipe missing `[doc]`) |
| **E** | `text-ban` | content | a banned regex in prose / content |
| **F** | `command-guard` | command | a banned shell command shape (richer guards stay dedicated hooks) |
| **P** | `protected-path` | path | a content-free edit/commit of a protected path (generated / vendored) |
| **G** | `tool-gate` | project | an external tool exits non-zero (depcruise, coverage…) — commit/push only |

A–E, F, P are **signposts-native** (the logic lives here). G is **tool-delegated** — the
tool owns its config file; signposts only orchestrates (run + trigger + block-on-nonzero).

## Built (all with samples; `just test-rules` green)

| Rule | `use:` | Catches |
|---|---|---|
| `date-default-no-nullish` | ast-grep (auto) | `?? new Date()` instead of `\|\|` (dormant until a `.ts`/`.tsx` exists) |
| `no-package-scripts` | `json-invariant` | real keys in `package.json` `scripts` (the justfile is the home) |
| `justfile-docs` | `./rules/check-justfile-docs.mjs` | a justfile recipe without a `[doc("…")]` attribute |
| `no-edit-generated` | `protected-path` | a hand edit of `**/*.generated.ts` / `vendor/**` |
| git-discard guard | dedicated Bash hook | `git checkout -- <paths>` / `git restore <paths>` about to wipe uncommitted edits (stash first, or append `# discard-ok`) |

The matcher for `signposts.yaml` advisory notes lives in `.claude/hooks/signposts-core.mjs`
(pure, `--test`); `signposts.mjs` is the PostToolUse shell that injects them.

## signposts.yaml schema

A bundle carries **one** `signposts.yaml`, each section with a single consumer:

| Section | Consumer | Holds |
|---|---|---|
| `project:` | `npx signposts` | bundle identity (`bundle`, `description`) |
| `config:` | `signposts.mjs` hook | engine runtime config (`drift_tokens`) |
| `advisory:` | `signposts.mjs` hook | the proactive signs (glob/command matcher → note) |
| `rules:` | the category engine | **rule instances** (a list) — each names a primitive + its config + `when:` |
| `install:` | `npx signposts` | files → destinations, `devDependencies`, `activate` commands |

**A rule instance:**

```yaml
- id: no-package-scripts      # unique id (also how ruleConfig finds it)
  use: json-invariant         # a built-in primitive, OR ./path to your own script
  on: "package.json"          # glob(s) the rule fires on (path primitives use deny:/sibling: instead)
  assert: { path: scripts, keysPrefixedWith: "//" }   # primitive-specific config
  when: [edit, commit]        # triggers: edit = pre-emptive; commit/push = the gate
  message: "…"                # the human reason, fed back on a block
```

- **ast-grep rules are auto-discovered** from `rules/ast-grep/*.yml` and need no `rules:`
  entry — the YAML pattern *is* the config (the zero-code authoring path).
- **`use:` = a built-in primitive name OR a path** (`./rules/check-x.mjs`) to your own
  script — the escape hatch. An own-script default-exports `{ category, kind, evaluate(rule, ctx) }`
  and **guards its CLI** so importing it has no side-effects.
- **`ruleConfig('<id>')`** (`rules/_config.mjs`) returns a rule's instance for the few checks
  that still read config directly; it accepts the instance-list form (find by `id`).

## Adding a rule

Author it with the **`/signposts`** skill. Three cases:

1. **Ban/require a code pattern** → drop a `rules/ast-grep/<name>.yml`. Zero code.
2. **A structural / path / file invariant** → add a `rules:` instance naming a built-in
   primitive + its config. No code.
3. **Genuinely novel** → write a small own-script (`use: ./rules/<name>.mjs`), ship a
   `--test` (legal + illegal sample), then `/propagate` it so it graduates into a core
   primitive. Either way: wire nothing by hand — the engine job already runs every instance.
