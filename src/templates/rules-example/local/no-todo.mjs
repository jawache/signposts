// An EXAMPLE script rule (delete once you get the shape). Wired from signposts.yaml with
// `use: local/no-todo`. A script default-exports { kind, evaluate }, and ships a --test
// (a legal + an illegal sample) that `just test-rules` runs.
//
//   kind: 'content'  → the engine hands you ctx = { path, content, root, phase, … };
//   return an array of hit strings (empty = pass; anything in it = block).

export function findTodos(content) {
  return content.split('\n')
    .map((line, i) => (/\bTODO\b/.test(line) ? `line ${i + 1}: leftover TODO` : null))
    .filter(Boolean);
}

export default {
  kind: 'content',
  evaluate(rule, ctx) {
    return findTodos(ctx.content).map((h) => `${ctx.path} — ${h} (finish it or open an issue)`);
  },
};

// Guard the CLI so importing this has no side-effects; `--test` is its proof.
if (process.argv[1] && process.argv[1].endsWith('no-todo.mjs') && process.argv[2] === '--test') {
  const legal = findTodos('const x = 1;\n').length === 0;
  const illegal = findTodos('const x = 1; // TODO fix\n').length === 1;
  console.log(legal && illegal ? 'PASS local/no-todo' : 'FAIL local/no-todo');
  process.exit(legal && illegal ? 0 : 1);
}
