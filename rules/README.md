# rules/ — the project's runnable rules

The enforceable half of the project's conventions. Each rule that used to be prose
("never do X") is a check that fires when you do X, with a verbose error that names
the violation, explains why, and shows the fix. The check is the source of truth.

This is the **core** set — the rules that govern any repo (no stack assumptions).
Stack-specific rules (the `src/lib` architecture, `.env` encryption, Astro templates,
…) ship in their own **bundles** and are dropped in by `npx signposts` when you opt
into that stack — they are not here.

## Prove they work

Every rule has valid/invalid **samples** — they're the test, the documentation, and
the spec. One command proves the lot:

```
just test-rules    # ast-grep tests + every check's self-test
```

## How it runs

`lefthook.yml` is the single orchestrator. Triggers:

- **agent-edit** — fast, file-local; fires on every Claude Edit/Write via `.claude/hooks/lefthook-on-write.sh`.
- **pre-commit** — the full gate over the staged set. Runs **without Claude** (on a plain
  `git commit`), which is why the rule files live committed in the repo, not in a per-user cache.
- **pre-Bash** — two checks run as PreToolUse hooks on Bash in `.claude/settings.json`, not via
  lefthook, because they must fire *before* the command runs: `check-git-discard` (an
  irreversible working-tree wipe) and `strip-claude-attribution` (a commit/PR carrying AI attribution).

Edit-time guidance (non-blocking) is separate: the `signposts.mjs` PostToolUse hook injects
per-area notes from `signposts.yaml`.

## Tooling per rule type

| Rule type | Tool | Why |
|---|---|---|
| TS/TSX AST patterns | **ast-grep** (`rules/ast-grep/*.yml`) | real parser, no false matches on strings/comments |
| Cross-statement / file logic | **node** (`rules/check-*.mjs`) | needs more than a single AST match |
| Filesystem / command shape | **bash** (`rules/check-*.sh`) | not a code pattern |

## Built (all with samples; `just test-rules` green)

| Rule | File | Catches |
|---|---|---|
| `date-default-no-nullish` | `ast-grep/date-default-no-nullish.yml` | `?? new Date()` instead of `\|\|` (dormant until a `.ts`/`.tsx` exists) |
| no-package-scripts | `check-no-package-scripts.mjs` | real keys in `package.json` `scripts` (the justfile is the home) |
| justfile-docs | `check-justfile-docs.mjs` | a justfile recipe without a `[doc("…")]` attribute |
| git-discard guard | `check-git-discard.mjs` (PreToolUse on Bash) | `git checkout -- <paths>` / `git restore <paths>` about to wipe uncommitted edits (stash first, or append `# discard-ok`) |

The matching engine for `signposts.yaml` (advisory notes + any future `avoid:` bans) lives in
`.claude/hooks/signposts-core.mjs` (pure, unit-tested by `--test`); `signposts.mjs` is the
PostToolUse shell that injects notes; `signposts-test.mjs` is its integration test.

## signposts.yaml schema

A bundle carries **one** `signposts.yaml` — every config a rule, the engine, or the
installer needs, each section with a single consumer:

| Section | Consumer | Holds |
|---|---|---|
| `project:` | `npx signposts` | bundle identity (`bundle`, `description`) |
| `config:` | `signposts.mjs` hook | engine runtime config (`drift_tokens`) |
| `advisory:` | `signposts.mjs` hook | the proactive signs (glob/command matcher → note) |
| `rules:` | a parameterised check | per-rule parameters, keyed by rule name |
| `install:` | `npx signposts` | files → destinations, `devDependencies`, `activate` commands |

**The rule-config contract.** A check receives the **files to scan as positional path
args** (the lefthook contract: `node rules/check-x.mjs <file> …`). Its **config** comes
from `signposts.yaml` via `rules/_config.mjs` → `ruleConfig('<rule-name>')`, which returns
that rule's slice of `rules:` (or `{}` — so a rule with no config keeps its defaults). This
is the one calling convention; a rule never parses `signposts.yaml` itself.

Worked example — `check-justfile-docs` reads `rules.justfile-docs.exempt` (recipe names that
don't need a `[doc]`): the files still arrive as args, only the exempt list comes from config.

**ast-grep rules are exempt.** They're declarative — the YAML pattern *is* the config, and
ast-grep can't read `signposts.yaml` at runtime — so pattern rules never appear under `rules:`.
Only imperative checks (node / shell) read config. That's the resolution of the "one config
every rule reads" question: *every imperative rule reads one config; declarative rules carry
theirs as the pattern.*

## Adding a rule

Author it with the **`/signposts`** skill. In short: write the check at the right shape, ship a
`--test` (a legal + an illegal sample), wire it into both lefthook groups + the `test-rules`
recipe, and add a row here.
