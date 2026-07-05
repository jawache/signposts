# rules/ — your project's rules live here

Signposts' engine and built-in rule types live in the `signposts` package
(`node_modules/signposts`). **This folder is yours** — the rules *you* write for
*this* project. It's grouped by namespace: `rules/<namespace>/<name>.{mjs,sh}`.

Two authoring paths, one example of each is seeded here (delete them once you get the idea):

- **`ast-grep/no-nullish-date.yml`** — a declarative code-pattern rule (zero code). Any
  `.yml` you drop in `rules/ast-grep/` is auto-discovered. It bans a TS/TSX syntax shape.
- **`local/no-todo.mjs`** — a script rule. It's referenced from `signposts.yaml`
  (`use: local/no-todo`) and runs as `kind: 'content'` over the file being written.

To wire the script example up, uncomment its block in `signposts.yaml`.

Built-in rule types you can use without writing code: `core/protected-path`,
`core/json-invariant`, `core/text-ban`, `core/command-guard`, `core/sibling-exists`,
`core/symbols-in-sibling`, `core/tool-gate`, `core/ast-grep`. Author more with
`/signposts reflect`.
