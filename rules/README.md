# rules/ — the project's runnable rules

The enforceable half of the project's conventions. Each rule that used to be prose
("never do X") is a check that fires when you do X, with a verbose error that names
the violation, explains why, and shows the fix. The check is the source of truth.

A **rule** names a **script** with `use:` (always a path) and carries that script's
config inline. There's no category registry and no glue — `use:` is just a script:

- `use: core/<name>` → `rules/core/<name>.mjs` — the shipped scripts (below).
- `use: <namespace>/<name>` → `rules/<namespace>/<name>.{mjs,sh}` — your own.

Rules are declared **grouped by namespace** under `rules:` in `signposts.yaml`. See
`docs/` for the canonical guide; this file is the implementation reference.

## Prove they work

Every rule ships a colocated **`<name>.test.yml`** — `valid`/`invalid` samples (data, not
code) run through the **real engine**, so green means the rule blocks in production, not in a
mock. It's the test, the documentation, and the spec in one file. One command proves the lot:

```
signposts test     # every rule's .test.yml through the engine + validates ast-grep ymls parse
just test-rules    # the engine internals' self-tests, then `signposts test`
```

The `rules-have-tests` rule (via `core/sibling-exists`) makes this structural: a rule under
`rules/` without its `.test.yml` sibling is blocked — you can't ship an untested rule.

## How it runs — one engine, two triggers

`rules/_engine.mjs` is the evaluator. A rule's `when:` decides which triggers it fires
on (**default `[edit, commit]`**, so one config line drives both paths):

- **edit** — the `preemptive-block.mjs` PreToolUse hook reconstructs the would-be file
  *in memory* and asks the engine (`phase: edit`). A violation is returned as a `deny`
  **before the write lands**, fed back so Claude self-corrects.
- **commit / push** — `lefthook.yml`'s `engine` job runs the same engine
  (`--phase commit`) over the staged set. Runs **without Claude** (a plain `git commit`),
  which is why the rule files live committed in the repo, not in a per-user cache.

One safety check stays a **dedicated PreToolUse Bash hook** (not an engine rule) because
it must fire before a *command* runs and needs live git state: `check-git-discard` (an
irreversible working-tree wipe). Edit-time *guidance* (non-blocking) is separate again:
the `signposts.mjs` PostToolUse hook injects per-area **signs** from `signposts.yaml`.

## The core scripts (`rules/core/`)

Each script is its own file, default-exporting `{ kind, evaluate(rule, ctx), test() }`.
`kind` tells the engine what to feed it.

| `use:` | Kind | Catches |
|---|---|---|
| `core/ast-grep` | content | a TS/TSX AST pattern — patterns are **files** in `rules/ast-grep/*.yml`, **auto-discovered**, run in-process via `@ast-grep/napi` |
| `core/sibling-exists` | path | a required sibling file is missing (no content parse) |
| `core/symbols-in-sibling` | content | an exported symbol never referenced in its sibling test (parser-as-library) |
| `core/json-invariant` | content | a structured-file invariant (e.g. `package.json` `scripts` must stay empty) |
| `core/text-ban` | content | a banned regex in prose / content |
| `core/command-guard` | command | a banned shell-command shape (richer guards stay dedicated hooks) |
| `core/protected-path` | path | a content-free edit/commit of a protected path (generated / vendored) |
| `core/tool-gate` | project | an external tool exits non-zero (depcruise, coverage…) — **commit/push only** |

All but `core/tool-gate` are **native** (in-process → pre-emptive on edit). `core/tool-gate`
is **tool-delegated**: the tool owns its config file; the script only runs it and blocks
on a non-zero exit. The line is per-file (native) vs whole-project (tool-gate).

## The calling contract

The engine hands each script four things (knowing *why* each is passed is the point):

| What | Always? | Why |
|---|---|---|
| the **config** | yes | the rule entry, verbatim — how the script reads its params (`deny`, `sibling`, …) |
| the **destination path** | yes | the logical path the file will live at — truth for messages + path logic, even at edit time |
| the **content** | content rules | the reconstructed would-be bytes |
| the **content-file path** | shell only | where to *read* those bytes: a **temp file @edit**, the **real file @commit** |

**JavaScript** gets it in memory — `evaluate(rule, ctx)` where
`ctx = { path, content, root, phase, exists(p), readText(p) }`; return an array of hit
strings (empty = pass).

**Shell** can't take a JS object, so the engine passes the config as **JSON on stdin** and
the two paths as **argv** (`$1` = destination, `$2` = content-file), plus `SIGNPOSTS_ROOT`
/ `SIGNPOSTS_PHASE` in the env; a **non-zero exit + a message on stderr** blocks. The
engine materialises a temp file at edit and points `$2` at the real file at commit, so the
script never has to know which trigger it's on. See `rules/local/no-ai-attribution.sh`.

## This repo's rules (`local`)

Built on core scripts, plus two own-scripts under `rules/local/`:

| Rule | `use:` | Catches |
|---|---|---|
| `signposts-self-regard` (`core` ns) | `core/protected-path` | the day-one demo — creating `signposts-is-bad.yaml` is denied |
| `no-package-scripts` | `core/json-invariant` | real keys in `package.json` `scripts` (the justfile is the home) |
| `justfile-docs` | `local/justfile-docs` | a justfile recipe without a `[doc("…")]` (JS own-script) |
| `no-ai-attribution` | `local/no-ai-attribution` | a Claude/Anthropic attribution marker in prose (**shell** own-script) |
| `no-edit-generated` | `core/protected-path` | a hand edit of `**/*.generated.ts` / `vendor/**` |
| `date-default-no-nullish` | `core/ast-grep` (auto) | `?? new Date()` instead of `\|\|` (dormant until a `.ts`/`.tsx` exists) |
| git-discard guard | dedicated Bash hook | `git checkout -- <paths>` about to wipe uncommitted edits (stash first, or append `# discard-ok`) |

## signposts.yaml schema

One `signposts.yaml` at the repo root, each section with a single consumer:

| Section | Consumer | Holds |
|---|---|---|
| `project:` | the CLI | stack identity (`name`, `description`) |
| `config:` | `signposts.mjs` hook | engine runtime config (`drift_tokens`) |
| `signs:` | `signposts.mjs` hook | the **signs**, grouped by namespace (glob → note) |
| `rules:` | the engine | the **rules**, grouped by namespace — each names a script + config + `when:` |
| `settings:` | the CLI (install) | optional host-permission entries a pack carries, per namespace → merged into `.claude/settings.json` |
| `packs:` | the CLI | installed packs + what each owns (object form), for `refresh` / `uninstall --pack` |
| `install:` | the CLI | files → destinations, `devDependencies`, `activate` commands |

**A rule entry:**

```yaml
rules:
  local:
    - id: no-package-scripts        # unique id
      use: core/json-invariant      # a script path — core/<name> or <ns>/<name>
      on: "package.json"            # glob(s) it fires on (path rules use deny:/sibling: instead)
      assert: { path: scripts, keysPrefixedWith: "//" }   # script-specific config, verbatim
      message: "…"                  # the human reason, fed back on a block
      # when: defaults to [edit, commit] — omit unless overriding (a tool-gate is [commit])
```

- **ast-grep patterns are files** (`rules/ast-grep/*.yml`), auto-discovered → no `rules:`
  entry (so `ast-grep scan` and the test runner share one source of truth).
- **`ruleConfig('<id>')`** (`rules/_config.mjs`) returns a rule's entry across namespaces —
  for a script's own standalone CLI; the engine passes config verbatim otherwise.

## Adding a rule

Author it with the **`/signposts`** skill (`reflect` proposes one from what happened).

**Check before you script.** Before writing an own-script, confirm neither of the no-code
shapes fits *and* the pack doesn't already ship it — `npx signposts diff
node_modules/signposts` (source #1) shows the installed pack's actual rules. Most "novel"
rules aren't. Three shapes, cheapest first:

1. **Ban/require a code pattern** → drop a `rules/ast-grep/<name>.yml`. Zero code.
2. **A structural / path / file invariant** → a `rules:` entry naming a **core script** +
   its config. No code.
3. **Genuinely novel** → a small own-script under your namespace
   (`use: <ns>/<name>`, JS or shell), shipping a `--test`. Then `/signposts propagate`
   sends it upstream. Either way: wire nothing by hand — the engine runs every entry.
