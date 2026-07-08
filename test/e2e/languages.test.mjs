// test/e2e/languages.test.mjs — C: `detect` reads the stack; grammars get in two ways, both
// registered by the engine from config: a PREBUILT @ast-grep/lang-* package (add), or a CUSTOM
// grammar declared in sgconfig.yml customLanguages (register — the astro/vue/svelte path).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { makeProject, runCli, runEngine, write, read } from './harness.mjs';

test('`signposts detect --json` reads file census + stack signals', () => {
  const dir = makeProject();
  write(dir, 'package.json', JSON.stringify({ name: 'app', type: 'module', dependencies: { '@neondatabase/serverless': '^0.9.0', astro: '^4.0.0' } }, null, 2));
  write(dir, 'src/index.ts', 'export const x = 1;\n');
  write(dir, 'src/page.astro', '---\nconst y = 1;\n---\n<div/>\n');
  const r = runCli(dir, ['detect', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  const byName = Object.fromEntries(rep.languages.map((l) => [l.name, l]));
  assert.ok(byName.typescript?.native, 'typescript is native (no grammar needed)');
  assert.ok(byName.astro && !byName.astro.native, 'astro detected, needs a grammar');
  assert.ok(byName.sql && byName.sql.sources.includes('deps'), 'sql inferred from the Neon dep alone');
  assert.deepEqual([...rep.recommend].sort(), ['astro', 'sql'], 'recommends the non-native languages');
});

test('`languages register` declares a custom grammar in sgconfig.yml (the astro path, offline)', () => {
  const dir = makeProject();
  assert.equal(runCli(dir, ['--no-activate']).status, 0);         // scaffolds sgconfig.yml
  const r = runCli(dir, ['languages', 'register', 'astro', '--library-path', 'grammars/astro.so', '--ext', 'astro']);
  assert.equal(r.status, 0, `register:\n${r.stdout}${r.stderr}`);
  assert.match(read(dir, 'sgconfig.yml') || '', /customLanguages:[\s\S]*astro:[\s\S]*grammars\/astro\.so/, 'astro declared in customLanguages');
});

test('`languages add <published grammar>`: install + a rule for it fires end-to-end', (t) => {
  const dir = makeProject();
  assert.equal(runCli(dir, ['--no-activate']).status, 0);
  if (runCli(dir, ['languages', 'add', 'sql']).status !== 0) { t.skip('npm registry unreachable — cannot fetch @ast-grep/lang-sql'); return; }
  write(dir, 'rules/db/ast-grep/no-select-star.yml', 'id: no-select-star\nlanguage: sql\nfiles: ["**/*.sql"]\nmessage: name the columns\nrule:\n  pattern: SELECT * FROM $T\n');
  write(dir, 'q.sql', 'SELECT * FROM users WHERE id = 1;\n');
  const r = runEngine(dir, ['--phase', 'commit', 'q.sql']);
  assert.equal(r.status, 2, `the sql rule must fire on a real .sql file:\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no-select-star/, 'cites the sql rule');
});

// The astro path, proven with a REAL .so: a grammar the engine registers FROM sgconfig.yml
// customLanguages (not an npm import). We borrow the built sql grammar's .so as the stand-in for
// a hand-built astro.so — same mechanism: build/obtain a .so → register in sgconfig → engine
// reads it → a rule with that language fires.
test('a custom grammar in sgconfig.yml is registered by the engine and a rule fires', (t) => {
  const dir = makeProject();
  assert.equal(runCli(dir, ['--no-activate']).status, 0);
  if (runCli(dir, ['languages', 'add', 'sql']).status !== 0) { t.skip('npm registry unreachable'); return; }
  // borrow the built sql grammar's .so + its real symbol as a stand-in for a hand-built astro.so
  const meta = spawnSync('node', ['--input-type=module', '-e', 'import("@ast-grep/lang-sql").then(m=>process.stdout.write(JSON.stringify(m.default)))'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const { libraryPath, languageSymbol, expandoChar } = JSON.parse(meta);
  assert.ok(libraryPath && libraryPath.endsWith('.so'), `resolved the built grammar .so: ${libraryPath}`);
  // register it under a CUSTOM name — --symbol handles name≠symbol (the general case)
  assert.equal(runCli(dir, ['languages', 'register', 'mydb', '--library-path', libraryPath, '--ext', 'mydb', '--symbol', languageSymbol, '--expando', expandoChar]).status, 0, 'register the .so in sgconfig');
  write(dir, 'rules/db/ast-grep/no-star.yml', 'id: no-star\nlanguage: mydb\nfiles: ["**/*.mydb"]\nmessage: no star\nrule:\n  pattern: SELECT * FROM $T\n');
  write(dir, 'q.mydb', 'SELECT * FROM users;\n');
  const r = runEngine(dir, ['--phase', 'commit', 'q.mydb']);
  assert.equal(r.status, 2, `the engine must register the sgconfig custom grammar and fire the rule:\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /no-star/, 'the custom-language rule fired');
});
