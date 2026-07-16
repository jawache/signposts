// test/e2e/scaffold.test.mjs — `npx signposts` sets a repo up, and the engine runs FROM
// node_modules to block all four quick-start tour beats (clean variants pass).

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, runCli, runEngine, write, read, has } from './harness.mjs';

test('scaffold writes config + wiring, seeds the tour, ignores .signposts/', () => {
  const dir = makeProject();
  const r = runCli(dir, ['--no-activate']);           // deps already present (base install) — just write files
  assert.equal(r.status, 0, `scaffold exit:\n${r.stdout}${r.stderr}`);
  for (const f of ['signposts.yml', 'lefthook.yml', 'justfile', '.claude/settings.json',
    '.claude/skills/signposts/SKILL.md', 'rules/examples/no-hardcoded-secret.sh',
    'rules/examples/ast-grep/functional-style.yml']) {
    assert.ok(has(dir, f), `scaffold should write ${f}`);
  }
  assert.match(read(dir, '.gitignore') || '', /\.signposts\//, '.gitignore ignores the engine log');
  // hooks point at the installed package, not a vendored copy.
  assert.match(read(dir, '.claude/settings.json') || '', /node_modules\/signposts/);
});

test('the engine runs from node_modules — all 4 tour beats block, clean variants pass', () => {
  const dir = makeProject();
  assert.equal(runCli(dir, ['--no-activate']).status, 0);

  // Fixtures. Every src/*.ts also trips test-first (needs a .test.ts sibling), so the
  // clean variants ship their sibling — isolating the beat under test.
  write(dir, 'signposts-is-bad.yaml', 'note: this triggers beat 1\n');   // 1 · protected-path
  write(dir, 'ok.yaml', 'note: fine\n');
  write(dir, 'src/lonely.ts', 'export const a = 1;\n');                  // 2 · sibling-exists (no sibling)
  write(dir, 'src/paired.ts', 'export const a = 1;\n'); write(dir, 'src/paired.test.ts', 'export {};\n');
  write(dir, 'src/imp.functional.ts', 'let total = 0;\nexport const v = total;\n');   // 3 · ast-grep (let)
  write(dir, 'src/imp.functional.test.ts', 'export {};\n');
  write(dir, 'src/pure.functional.ts', 'export const v = [1, 2].reduce((a, b) => a + b, 0);\n');
  write(dir, 'src/pure.functional.test.ts', 'export {};\n');
  write(dir, 'src/secret.ts', 'export const API_KEY = "sk-live-abc123";\n');          // 4 · shell rule
  write(dir, 'src/secret.test.ts', 'export {};\n');
  write(dir, 'src/clean.ts', 'export const x = 1;\n'); write(dir, 'src/clean.test.ts', 'export {};\n');

  const blocks = (file, idFragment) => {
    const r = runEngine(dir, ['--phase', 'commit', file]);
    assert.equal(r.status, 2, `${file} should BLOCK (exit 2). got ${r.status}:\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(idFragment), `${file}: expected the "${idFragment}" message`);
  };
  const passes = (file) => {
    const r = runEngine(dir, ['--phase', 'commit', file]);
    assert.equal(r.status, 0, `${file} should PASS (exit 0). got ${r.status}:\n${r.stdout}${r.stderr}`);
  };

  blocks('signposts-is-bad.yaml', 'no-bad-mouthing');   passes('ok.yaml');
  blocks('src/lonely.ts', 'test-first');                passes('src/paired.ts');
  blocks('src/imp.functional.ts', 'functional-style');  passes('src/pure.functional.ts');
  blocks('src/secret.ts', 'no-hardcoded-secret');       passes('src/clean.ts');
});

test('scaffold --dry-run writes nothing', () => {
  const dir = makeProject();
  const r = runCli(dir, ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['signposts.yml', 'lefthook.yml', 'justfile', '.claude/settings.json', 'rules/examples/no-hardcoded-secret.sh']) {
    assert.ok(!has(dir, f), `--dry-run must not write ${f}`);
  }
});

test('scaffold keeps an existing lefthook.yml / justfile', () => {
  const dir = makeProject();
  write(dir, 'lefthook.yml', '# my custom lefthook\n');
  write(dir, 'justfile', '# my custom justfile\n');
  assert.equal(runCli(dir, ['--no-activate']).status, 0);
  assert.match(read(dir, 'lefthook.yml'), /my custom lefthook/, 'existing lefthook.yml kept');
  assert.match(read(dir, 'justfile'), /my custom justfile/, 'existing justfile kept');
});

test('scaffold does not double-list a dep already in dependencies', () => {
  const dir = makeProject();
  // a consumer that already carries signposts (+lefthook) in dependencies
  const pkg0 = JSON.parse(read(dir, 'package.json'));
  pkg0.dependencies = { ...(pkg0.dependencies || {}), signposts: '^0.1.0' };
  write(dir, 'package.json', JSON.stringify(pkg0, null, 2));
  assert.equal(runCli(dir, ['--no-activate']).status, 0);
  const pkg = JSON.parse(read(dir, 'package.json'));
  assert.ok(pkg.dependencies.signposts, 'signposts kept in dependencies');
  assert.ok(!(pkg.devDependencies && pkg.devDependencies.signposts), 'NOT also added to devDependencies (no double-listing)');
});
