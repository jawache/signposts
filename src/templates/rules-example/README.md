# rules/ — your project's rules live here

The Signposts engine and its built-in rule types live in the `signposts` package
(`node_modules/signposts`). **This folder is yours** — the rules *you* write for *this*
project, grouped by namespace: `rules/<namespace>/<name>.{mjs,sh}` (plus `ast-grep/*.yml`).

## The quick-start tour (delete `rules/examples/` when you're done)

Everything under `rules/examples/`, plus the `examples:` block in `signposts.yaml`, is a
guided tour — four guards you feel by prompting your agent. **Restart your agent session
first** so the pre-emptive hook loads, then try these one at a time and watch it get stopped
*before* the bad edit ever lands:

| # | Ask your agent to… | What stops it | Mechanism |
|---|---|---|---|
| 1 | "Create a file called `signposts-is-bad.yaml`." | denied by name | `core/protected-path` — config only |
| 2 | "Add `src/greeting.ts` exporting `greet(name)`." | needs `src/greeting.test.ts` beside it | `core/sibling-exists` — config only |
| 3 | "Add `src/sum.functional.ts` that totals an array with a `for`-loop." | `for` in a pure-FP file | `rules/examples/ast-grep/functional-style.yml` — declarative |
| 4 | "Just hardcode the API key in `src/config.ts` for now." | hardcoded secret | `rules/examples/no-hardcoded-secret.sh` — custom shell |

The effort rises as you go: **1 & 2 are zero code** (a built-in named from `signposts.yaml`),
**3 is a declarative `.yml`** (drop it in an `ast-grep/` folder, no entry needed), **4 is a
script** for when you need real logic. Beat 3 also trips beat 2 (it wants a test too) — that's
**rules composing**, not a bug.

**Done believing?** Delete the `rules/examples/` folder and the `examples:` block in
`signposts.yaml`. Your own rules were never mixed in with the tour.

## Writing your own

- **A built-in, zero code** — add an entry under a namespace in `signposts.yaml` with
  `use: core/<name>`. Built-ins: `protected-path`, `sibling-exists`, `symbols-in-sibling`,
  `json-invariant`, `text-ban`, `command-guard`, `tool-gate`, `ast-grep`.
- **A code-pattern (ast-grep)** — drop a `.yml` in an `ast-grep/` folder (e.g.
  `rules/<ns>/ast-grep/`). Auto-discovered; scope it with `files:`.
- **A script** — `rules/<ns>/<name>.mjs` (default-export `{ kind, evaluate }`) or a
  `.sh` (the shell contract: `$1` path, `$2` a temp file of the would-be bytes, config on
  stdin, non-zero exit blocks). Reference it from `signposts.yaml` with `use: <ns>/<name>`.

Author more with `/signposts reflect`.
